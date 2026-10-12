import { getChromeRuntimeError, setActionBadge } from "./lib/chrome";
import type { StoredConfig } from "./types/storage";
import { isImportInProgress, type StoredImport } from "./types/importStatus";
import {
  createNorishClient,
  extractErrorMessage,
  getPendingImportIds,
  getRecipeStatus,
  normalizeToDomain,
} from "./lib/api";

const IMPORT_STATUS_SYNC_ALARM = "norish-import-monitor";
const IMPORT_STATUS_POLL_INTERVAL_MINUTES = 1;
const POLL_INTERVAL_MS = 4000; // every check costs requests towards the API key limit
// Norish keeps a list of queued and running imports; an import that left it
// either produced the recipe or failed. The timeout only guards against a
// Norish that never answers (it counts from when the import was queued, so a
// restarted service worker does not start over).
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const FAILED_MESSAGE =
  "Norish could not import this page (no recipe found, or Norish already has it).";

function syncBadgeWithImportStatus(lastImport: StoredImport | undefined): void {
  if (lastImport?.status === "success") {
    setActionBadge("success");
    return;
  }

  if (lastImport?.status === "error") {
    setActionBadge("error");
    return;
  }

  setActionBadge("clear");
}

function storageGet<T>(
  area: chrome.storage.StorageArea,
  keys: string[],
): Promise<T> {
  return new Promise((resolve, reject) => {
    area.get(keys, (result) => {
      const runtimeError = getChromeRuntimeError();
      if (runtimeError) {
        reject(new Error(runtimeError));
        return;
      }
      resolve(result as T);
    });
  });
}

function storageSet(
  area: chrome.storage.StorageArea,
  values: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    area.set(values, () => {
      const runtimeError = getChromeRuntimeError();
      if (runtimeError) {
        reject(new Error(runtimeError));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(
  area: chrome.storage.StorageArea,
  key: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    area.remove(key, () => {
      const runtimeError = getChromeRuntimeError();
      if (runtimeError) {
        reject(new Error(runtimeError));
        return;
      }
      resolve();
    });
  });
}

async function getLastImport(): Promise<StoredImport | undefined> {
  const result = await storageGet<{ lastImport?: StoredImport }>(
    chrome.storage.local,
    ["lastImport"],
  );
  return result.lastImport;
}

async function getConfig(): Promise<StoredConfig> {
  return storageGet<StoredConfig>(chrome.storage.sync, [
    "instanceDomain",
    "apiKey",
  ]);
}

async function persistLastImport(next: StoredImport | null): Promise<void> {
  if (!next) {
    await storageRemove(chrome.storage.local, "lastImport");
    setActionBadge("clear");
    return;
  }

  await storageSet(chrome.storage.local, {
    lastImport: {
      ...next,
      timestamp: Date.now(),
    },
  });
  syncBadgeWithImportStatus(next);
}

async function syncImportMonitorAlarm(): Promise<void> {
  const lastImport = await getLastImport();
  if (isImportInProgress(lastImport)) {
    chrome.alarms.create(IMPORT_STATUS_SYNC_ALARM, {
      periodInMinutes: IMPORT_STATUS_POLL_INTERVAL_MINUTES,
    });
    return;
  }

  await chrome.alarms.clear(IMPORT_STATUS_SYNC_ALARM);
}

function isTerminalMonitorError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;

  // Treat authentication/authorization issues as terminal.
  return (
    normalized.includes("invalid api key") ||
    normalized.includes("you must be logged in")
  );
}

type ImportCheck = "done" | "failed" | "waiting";

/** One look at the import: recipe there, import gone without it, or still busy. */
async function checkImport(
  baseUrl: string,
  apiKey: string,
  recipeId: string,
): Promise<ImportCheck> {
  if (await getRecipeStatus(baseUrl, apiKey, recipeId)) return "done";

  let pending: Set<string>;
  try {
    pending = await getPendingImportIds(baseUrl, apiKey);
  } catch (error) {
    if (isTerminalMonitorError(extractErrorMessage(error))) throw error;
    // Older Norish without the list: keep waiting for the recipe
    return "waiting";
  }
  if (pending.has(recipeId)) return "waiting";

  // Finished between the two calls? Look once more before calling it failed.
  return (await getRecipeStatus(baseUrl, apiKey, recipeId)) ? "done" : "failed";
}

/** Keeps the service worker alive between checks (extension API call). */
function keepAlive(): Promise<void> {
  return new Promise((resolve) =>
    chrome.runtime.getPlatformInfo(() => resolve()),
  );
}

/**
 * Poll until the recipe appears, the import fails, or the timeout passes.
 * @returns "done", "failed" or "timeout"
 */
async function pollRecipeStatus(
  baseUrl: string,
  apiKey: string,
  recipeId: string,
  startedAt: number,
): Promise<ImportCheck | "timeout"> {
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    try {
      const result = await checkImport(baseUrl, apiKey, recipeId);
      if (result !== "waiting") return result;
    } catch (error) {
      const message = extractErrorMessage(error);
      // Terminal errors should stop polling immediately
      if (isTerminalMonitorError(message)) {
        throw error;
      }
      // Temporary errors, retry
    }
    await keepAlive();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return "timeout";
}

let isSyncing = false;

async function syncImportStatusInBackground(): Promise<void> {
  if (isSyncing) return;

  const lastImport = await getLastImport();
  if (!lastImport || !isImportInProgress(lastImport)) {
    syncBadgeWithImportStatus(lastImport);
    await syncImportMonitorAlarm();
    return;
  }

  isSyncing = true;
  try {
    const recipeId = lastImport.recipeId;
    if (!recipeId) {
      await syncImportMonitorAlarm();
      return;
    }

    const config = await getConfig();
    const domain = normalizeToDomain(config.instanceDomain);
    if (!domain || !config.apiKey) {
      await syncImportMonitorAlarm();
      return;
    }

    let baseUrl: string;
    let apiKey: string;
    try {
      const apiConfig = await createNorishClient({
        instanceDomain: config.instanceDomain as string,
        apiKey: config.apiKey as string,
      } as Required<StoredConfig>);
      baseUrl = apiConfig.baseUrl;
      apiKey = apiConfig.apiKey;
    } catch {
      await syncImportMonitorAlarm();
      return;
    }

    const startedAt =
      lastImport.startedAt ?? lastImport.timestamp ?? Date.now();

    // Update status to "parsing" while checking
    if (lastImport.status !== "parsing") {
      await persistLastImport({
        status: "parsing",
        recipeId,
        startedAt,
        message: "Norish is processing your recipe.",
      });
    }

    try {
      const result = await pollRecipeStatus(
        baseUrl,
        apiKey,
        recipeId,
        startedAt,
      );

      if (result === "done") {
        await persistLastImport({
          status: "success",
          recipeId,
        });
      } else {
        await persistLastImport({
          status: "error",
          recipeId,
          message:
            result === "failed"
              ? FAILED_MESSAGE
              : "Norish did not finish the import in time. Please try again.",
        });
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      await persistLastImport({
        status: "error",
        recipeId,
        message,
      });
    }

    await syncImportMonitorAlarm();
  } finally {
    isSyncing = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncImportMonitorAlarm();
  void syncImportStatusInBackground();
});

chrome.runtime.onStartup.addListener(() => {
  void syncImportMonitorAlarm();
  void syncImportStatusInBackground();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && typeof message === "object" && "type" in message) {
    if (message.type === "monitor-import-now") {
      void syncImportStatusInBackground();
    }
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" && areaName !== "sync") return;
  if (changes.lastImport || changes.instanceDomain || changes.apiKey) {
    void syncImportMonitorAlarm();
    void syncImportStatusInBackground();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== IMPORT_STATUS_SYNC_ALARM) return;
  void syncImportStatusInBackground();
});

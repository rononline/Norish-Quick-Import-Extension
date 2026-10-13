import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  FieldError,
  Form,
  Input,
  Label,
  Link,
  TextField,
} from "@heroui/react";
import { XMarkIcon } from "@heroicons/react/20/solid";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/16/solid";
import {
  PaperAirplaneIcon,
  type PaperAirplaneIconHandle,
} from "@heroicons-animated/react/paper-airplane";
import { useCurrentTab } from "../hooks/useCurrentTabUrl";
import type { StoredConfig } from "../types/storage";
import {
  createNorishClient,
  defaultOriginForDomain,
  extractErrorMessage,
  importRecipeFromPaste,
  importRecipeFromUrl,
} from "../lib/api";
import { pasteTextFor, readRecipeFromTab } from "../lib/pageRecipe";
import { isExtensionContextValid } from "../lib/chrome";
import type { StoredImport } from "../types/importStatus";

interface RecipeImportFormProps {
  config: Required<StoredConfig>;
}

const MIN_SEND_ANIMATION_MS = 700;

type Status =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "parsing"; recipeId?: string; message?: string }
  | {
      type: "pending";
      recipeId: string;
      message?: string;
      startedAt?: number;
      kind?: StoredImport["kind"];
      url?: string;
      images?: string[];
    }
  | { type: "success"; recipeId?: string }
  | { type: "error"; message: string; recipeId?: string; url?: string };

function toStoredImport(status: Status): StoredImport | null {
  switch (status.type) {
    case "idle":
      return null;
    case "loading":
      return null;
    case "parsing":
      return {
        status: "parsing",
        recipeId: status.recipeId,
        message: status.message,
      };
    case "pending":
      return {
        status: "pending",
        recipeId: status.recipeId,
        message: status.message,
        startedAt: status.startedAt,
        kind: status.kind,
        url: status.url,
        images: status.images,
      };
    case "success":
      return { status: "success", recipeId: status.recipeId };
    case "error":
      return {
        status: "error",
        recipeId: status.recipeId,
        message: status.message,
        url: status.url,
      };
  }
}

function fromStoredImport(last: StoredImport | undefined): Status {
  if (!last) return { type: "idle" };

  switch (last.status) {
    case "success":
      return {
        type: "success",
        recipeId: last.recipeId,
      };
    case "error":
      return {
        type: "error",
        message: last.message ?? "Unknown error",
        recipeId: last.recipeId,
        url: last.url,
      };
    case "parsing":
      return {
        type: "parsing",
        recipeId: last.recipeId,
        message: last.message,
      };
    case "pending":
      if (!last.recipeId) return { type: "idle" };

      return {
        type: "pending",
        recipeId: last.recipeId,
        message: last.message,
      };
    case "loading":
      return { type: "idle" };
    default:
      return { type: "idle" };
  }
}

export default function RecipeImportForm({ config }: RecipeImportFormProps) {
  const tab = useCurrentTab();
  const tabUrl = tab.url;
  const [recipeUrl, setRecipeUrl] = useState("");
  const [status, setStatus] = useState<Status>({ type: "idle" });
  const planeRef = useRef<PaperAirplaneIconHandle>(null);
  const [instanceOrigin, setInstanceOrigin] = useState(() =>
    defaultOriginForDomain(config.instanceDomain),
  );

  const recipeBaseUrl = useMemo(() => {
    const origin =
      instanceOrigin || defaultOriginForDomain(config.instanceDomain);
    return `${origin.replace(/\/$/, "")}/recipes/`;
  }, [config.instanceDomain, instanceOrigin]);

  const persistStatus = useCallback((nextStatus: Status) => {
    if (!isExtensionContextValid()) return;

    const stored = toStoredImport(nextStatus);
    if (!stored) {
      chrome.storage.local.remove("lastImport");
      return;
    }

    chrome.storage.local.set({
      lastImport: {
        ...stored,
        timestamp: Date.now(),
      },
    });
  }, []);

  const setStatusAndPersist = useCallback(
    (nextStatus: Status) => {
      setStatus(nextStatus);
      persistStatus(nextStatus);
    },
    [persistStatus],
  );

  const clearStatus = useCallback(() => {
    setStatus({ type: "idle" });
    if (!isExtensionContextValid()) return;
    chrome.storage.local.remove("lastImport");
  }, []);

  const loadApiConfig = useCallback(async () => {
    const apiConfig = await createNorishClient(config);
    setInstanceOrigin(defaultOriginForDomain(config.instanceDomain));
    return apiConfig;
  }, [config]);

  const requestBackgroundMonitor = useCallback(() => {
    if (!isExtensionContextValid()) return;
    chrome.runtime.sendMessage({ type: "monitor-import-now" }, () => {
      // Ignore runtime errors if service worker is unavailable.
      void chrome.runtime.lastError;
    });
  }, []);

  useEffect(() => {
    if (!isExtensionContextValid()) return;

    const updateFromStorage = (res: { lastImport?: StoredImport }) => {
      const next = fromStoredImport(res.lastImport);
      setStatus(next);
      if (next.type === "pending" || next.type === "parsing") {
        requestBackgroundMonitor();
      }
    };

    chrome.storage.local.get(["lastImport"], (res) => {
      updateFromStorage(res as { lastImport?: StoredImport });
    });

    const listener = (changes: {
      [key: string]: chrome.storage.StorageChange;
    }) => {
      if (!changes.lastImport) return;

      updateFromStorage({
        lastImport: changes.lastImport.newValue as StoredImport | undefined,
      });
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [config.instanceDomain, requestBackgroundMonitor]);

  useEffect(() => {
    setInstanceOrigin(defaultOriginForDomain(config.instanceDomain));
  }, [config.instanceDomain]);

  useEffect(() => {
    if (tabUrl && !recipeUrl) {
      setRecipeUrl(tabUrl);
    }
  }, [tabUrl, recipeUrl]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = recipeUrl.trim();
    if (!trimmed) return;

    const animationStartedAt = Date.now();
    setStatusAndPersist({ type: "loading" });
    planeRef.current?.startAnimation();

    try {
      const { baseUrl, apiKey } = await loadApiConfig();

      const { recipeId, status: importStatus } = await importRecipeFromUrl(
        baseUrl,
        apiKey,
        trimmed,
      );

      if (importStatus === "exists") {
        // Norish already has this recipe: offer it right away
        setStatusAndPersist({ type: "success", recipeId });
        return;
      }

      setStatusAndPersist({
        type: "pending",
        recipeId,
        message: "Import queued. Waiting for parser status...",
        startedAt: Date.now(),
        kind: "url",
        url: trimmed,
      });
      requestBackgroundMonitor();
    } catch (error) {
      setStatusAndPersist({
        type: "error",
        message: extractErrorMessage(error),
        url: trimmed,
      });
    } finally {
      const elapsed = Date.now() - animationStartedAt;
      if (elapsed < MIN_SEND_ANIMATION_MS) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, MIN_SEND_ANIMATION_MS - elapsed),
        );
      }
      planeRef.current?.stopAnimation();
    }
  };

  // Reading the open page works where Norish itself is turned away (bot
  // checks): the browser already shows the recipe.
  const canImportFromPage =
    tab.id !== undefined && /^https?:\/\//i.test(tabUrl);

  const handleImportFromPage = async () => {
    if (tab.id === undefined) return;
    setStatusAndPersist({ type: "loading" });
    try {
      const page = await readRecipeFromTab(tab.id);
      const { baseUrl, apiKey } = await loadApiConfig();
      const recipeId = await importRecipeFromPaste(
        baseUrl,
        apiKey,
        pasteTextFor(page),
      );
      setStatusAndPersist({
        type: "pending",
        recipeId,
        message: page.jsonLd
          ? "Recipe read from the page. Waiting for Norish..."
          : "No recipe data on the page; Norish's AI reads the text. Waiting...",
        startedAt: Date.now(),
        kind: "page",
        url: page.url,
        images: page.images,
      });
      requestBackgroundMonitor();
    } catch (error) {
      setStatusAndPersist({
        type: "error",
        message: extractErrorMessage(error),
      });
    }
  };

  return (
    <Form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex items-end gap-2 w-full">
        <TextField
          className="flex-1"
          fullWidth
          value={recipeUrl}
          onChange={setRecipeUrl}
          isRequired
          name="recipeUrl"
        >
          <Label>Recipe URL</Label>
          <Input fullWidth placeholder="https://example.com/recipe" />
          <FieldError />
        </TextField>

        <Button
          type="submit"
          variant="primary"
          isIconOnly
          className="mb-[1px]"
          isDisabled={
            status.type === "loading" ||
            status.type === "parsing" ||
            status.type === "pending"
          }
          aria-label="Send"
        >
          <PaperAirplaneIcon ref={planeRef} size={18} />
        </Button>
      </div>

      {canImportFromPage && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onPress={handleImportFromPage}
          isDisabled={
            status.type === "loading" ||
            status.type === "parsing" ||
            status.type === "pending"
          }
        >
          Import from page content
        </Button>
      )}

      {status.type === "parsing" && (
        <Alert status="accent" className="items-start">
          <Alert.Indicator>
            <div className="animate-spin size-4 border-2 border-current border-t-transparent rounded-full" />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>Parsing recipe...</Alert.Title>
            <Alert.Description>
              {status.message && (
                <span className="text-xs opacity-80">{status.message}</span>
              )}
            </Alert.Description>
          </Alert.Content>
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            onPress={clearStatus}
            aria-label="Dismiss"
            className="mt-[-4px]"
          >
            <XMarkIcon className="size-4" />
          </Button>
        </Alert>
      )}

      {status.type === "pending" && (
        <Alert status="warning" className="items-start">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Import started</Alert.Title>
            <Alert.Description>
              <div className="flex flex-col gap-1">
                {status.message && (
                  <span className="text-xs opacity-80">{status.message}</span>
                )}
              </div>
            </Alert.Description>
          </Alert.Content>
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            onPress={clearStatus}
            aria-label="Dismiss"
            className="mt-[-4px]"
          >
            <XMarkIcon className="size-4" />
          </Button>
        </Alert>
      )}

      {status.type === "success" && (
        <Alert status="success" className="items-start">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Import successful</Alert.Title>
            <Alert.Description>
              <div className="flex flex-col gap-1">
                {status.recipeId && (
                  <Link
                    href={`${recipeBaseUrl}${status.recipeId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline font-medium"
                  >
                    Open in Norish
                    <span className="ml-1 inline-flex items-center justify-center align-middle">
                      <ArrowTopRightOnSquareIcon className="size-4 shrink-0" />
                    </span>
                  </Link>
                )}
              </div>
            </Alert.Description>
          </Alert.Content>
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            onPress={clearStatus}
            aria-label="Dismiss"
            className="mt-[-4px]"
          >
            <XMarkIcon className="size-4" />
          </Button>
        </Alert>
      )}

      {status.type === "error" && (
        <Alert status="danger" className="items-start">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Import failed</Alert.Title>
            <Alert.Description>
              <div className="flex flex-col gap-1">
                <span>{status.message}</span>
                {canImportFromPage && status.url === tabUrl && (
                  <span className="text-xs opacity-80">
                    Norish may be blocked by this site. Try &quot;Import from
                    page content&quot;: it reads the recipe from the page you
                    have open.
                  </span>
                )}
              </div>
            </Alert.Description>
          </Alert.Content>
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            onPress={clearStatus}
            aria-label="Dismiss"
            className="mt-[-4px]"
          >
            <XMarkIcon className="size-4" />
          </Button>
        </Alert>
      )}
    </Form>
  );
}

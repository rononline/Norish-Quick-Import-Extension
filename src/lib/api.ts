import type { StoredConfig } from "../types/storage";

function isLocalDomain(domain: string): boolean {
  return domain.includes("localhost") || /^(\d{1,3}\.){3}\d{1,3}/.test(domain);
}

export function normalizeToDomain(
  raw: string | undefined | null,
): string | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  return trimmed.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function candidateOrigins(domain: string): string[] {
  const normalized = domain.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const httpOrigin = `http://${normalized}`;
  const httpsOrigin = `https://${normalized}`;

  if (isLocalDomain(normalized)) {
    return [httpOrigin, httpsOrigin];
  }

  return [httpsOrigin];
}

export function defaultOriginForDomain(domain: string): string {
  const normalized = domain.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!normalized) return "";

  return isLocalDomain(normalized)
    ? `http://${normalized}`
    : `https://${normalized}`;
}

export async function createNorishClient(
  config: Required<StoredConfig>,
): Promise<{ baseUrl: string; apiKey: string }> {
  const domain = normalizeToDomain(config.instanceDomain);
  if (!domain || !config.apiKey) {
    throw new Error("Missing instance domain or API key");
  }

  const [primaryOrigin] = candidateOrigins(domain);
  const baseUrl = `${primaryOrigin}/api/v1`;

  return {
    baseUrl,
    apiKey: config.apiKey,
  };
}

export interface ImportResult {
  recipeId: string;
  /** "queued": Norish imports it in the background; "exists": already in Norish */
  status: "queued" | "exists";
}

/**
 * Read the import response. Current Norish answers
 * `{ recipeId, status: "queued" | "exists" }`; older versions answered with
 * the bare recipe UUID.
 */
export function parseImportResponse(data: unknown): ImportResult {
  if (typeof data === "string" && data) {
    return { recipeId: data, status: "queued" };
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.recipeId === "string" && obj.recipeId) {
      return {
        recipeId: obj.recipeId,
        status: obj.status === "exists" ? "exists" : "queued",
      };
    }
  }
  throw new Error("Unexpected response format from import endpoint");
}

/**
 * Import a recipe from a URL
 * @param baseUrl API base URL (e.g., https://norish.example.com/api/v1)
 * @param apiKey API authentication key
 * @param url Recipe URL to import
 * @returns Recipe UUID and whether it was queued or already exists
 */
export async function importRecipeFromUrl(
  baseUrl: string,
  apiKey: string,
  url: string,
): Promise<ImportResult> {
  const endpoint = `${baseUrl}/recipes/import/url`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ url, forceAI: false }),
  });

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = extractErrorMessageFromResponse(data, response.status);
    throw new Error(message);
  }

  return parseImportResponse(data);
}

/**
 * Get recipe status by ID. Returns null if recipe not found (still being parsed).
 * @param baseUrl API base URL
 * @param apiKey API authentication key
 * @param recipeId Recipe UUID
 * @returns Recipe object if found, null if 404 (still parsing/pending)
 */
export async function getRecipeStatus(
  baseUrl: string,
  apiKey: string,
  recipeId: string,
): Promise<{ id: string; name: string } | null> {
  const endpoint = `${baseUrl}/recipes/${recipeId}`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
    },
  });

  if (response.status === 404) {
    // Recipe not found = still being parsed/processed
    return null;
  }

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = extractErrorMessageFromResponse(data, response.status);
    throw new Error(message);
  }

  // Return minimal recipe info (id and name at least)
  if (data && typeof data === "object" && "id" in data && "name" in data) {
    return {
      id: (data as Record<string, unknown>).id as string,
      name: (data as Record<string, unknown>).name as string,
    };
  }

  throw new Error("Unexpected response format from recipe endpoint");
}

/**
 * IDs of the imports Norish still has queued or running (tRPC
 * recipes.getPending). An import that is no longer listed has finished:
 * either the recipe exists now, or the import failed.
 */
export async function getPendingImportIds(
  baseUrl: string,
  apiKey: string,
): Promise<Set<string>> {
  const origin = baseUrl.replace(/\/api\/v1\/?$/, "");
  const input = encodeURIComponent(JSON.stringify({ 0: { json: null } }));
  const response = await fetch(
    `${origin}/api/trpc/recipes.getPending?batch=1&input=${input}`,
    { method: "GET", headers: { "x-api-key": apiKey } },
  );

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(extractErrorMessageFromResponse(null, response.status));
  }

  const first = Array.isArray(data)
    ? (data[0] as Record<string, unknown>)
    : null;
  const result = first?.result as { data?: { json?: unknown } } | undefined;
  const list = result?.data?.json;
  if (!Array.isArray(list)) {
    throw new Error("Unexpected response format from pending imports");
  }

  return new Set(
    list
      .map((item) => (item as { recipeId?: unknown })?.recipeId)
      .filter((id): id is string => typeof id === "string"),
  );
}

function extractErrorMessageFromResponse(
  data: unknown,
  status: number,
): string {
  // Try to extract error message from response body
  if (data && typeof data === "object") {
    const errorObj = data as Record<string, unknown>;
    if ("message" in errorObj && typeof errorObj.message === "string") {
      return errorObj.message;
    }
    if ("error" in errorObj && typeof errorObj.error === "string") {
      return errorObj.error;
    }
  }

  // Fallback to status codes
  switch (status) {
    case 401:
      return "Invalid API key (please check your API key in settings)";
    case 403:
      return "Access denied to this API";
    case 409:
      return "This recipe is already being imported";
    case 412:
      return "Video imports need AI and video parsing enabled in Norish";
    case 422:
      return "Invalid request (invalid URL format?)";
    case 503:
      return "API service is temporarily unavailable";
    default:
      return `Server error (${status})`;
  }
}

export function extractErrorMessage(error: unknown): string {
  const fallback = error instanceof Error ? error.message : String(error);
  const message = fallback || "Unknown error";
  const normalized = message.toLowerCase();

  const isNetworkError = normalized.includes("failed to fetch");

  if (isNetworkError) {
    return "Norish instance unreachable.";
  }

  if (message === "You must be logged in to access this resource") {
    return "Invalid API key (please check your API key in settings)";
  }

  return message;
}

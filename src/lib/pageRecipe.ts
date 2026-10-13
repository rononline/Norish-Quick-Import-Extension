import { getChromeRuntimeError } from "./chrome";

export interface PageRecipe {
  /** schema.org Recipe found in the page's JSON-LD, if any */
  jsonLd: Record<string, unknown> | null;
  /** Visible text of the page, for Norish's AI when there is no JSON-LD */
  text: string;
  title: string;
  url: string;
}

/**
 * Runs in the page (via chrome.scripting): returns the page's schema.org
 * Recipe and visible text. Must be self-contained – it is serialized.
 */
export function readRecipeInPage(): PageRecipe {
  const isRecipe = (node: Record<string, unknown>): boolean => {
    const type = node["@type"];
    return (
      type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))
    );
  };
  const find = (node: unknown): Record<string, unknown> | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = find(item);
        if (found) return found;
      }
      return null;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (isRecipe(obj)) return obj;
      if (obj["@graph"]) return find(obj["@graph"]);
      if (obj.mainEntity) return find(obj.mainEntity);
    }
    return null;
  };

  let jsonLd: Record<string, unknown> | null = null;
  const scripts = document.querySelectorAll(
    'script[type="application/ld+json"]',
  );
  for (const script of Array.from(scripts)) {
    try {
      jsonLd = find(JSON.parse(script.textContent || "null"));
    } catch {
      jsonLd = null;
    }
    if (jsonLd) break;
  }

  const main =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.body;
  return {
    jsonLd,
    text: (main?.innerText || "").slice(0, 60000),
    title: document.title,
    url: location.href,
  };
}

/** Read the recipe from a tab the user has open (their own browser session). */
export async function readRecipeFromTab(tabId: number): Promise<PageRecipe> {
  const results = await new Promise<chrome.scripting.InjectionResult[]>(
    (resolve, reject) => {
      chrome.scripting.executeScript(
        { target: { tabId }, func: readRecipeInPage },
        (res) => {
          const runtimeError = getChromeRuntimeError();
          if (runtimeError) {
            reject(new Error(runtimeError));
            return;
          }
          resolve(res ?? []);
        },
      );
    },
  );
  const result = results[0]?.result as PageRecipe | undefined;
  if (!result) throw new Error("Could not read this page");
  return result;
}

/**
 * Text for Norish's paste import: the page's JSON-LD recipe (with the page as
 * its source URL) or, without one, the page title, URL and visible text.
 */
export function pasteTextFor(page: PageRecipe): string {
  if (page.jsonLd) {
    return JSON.stringify({
      "@context": "https://schema.org",
      ...page.jsonLd,
      url: typeof page.jsonLd.url === "string" ? page.jsonLd.url : page.url,
    });
  }
  return `${page.title}\n${page.url}\n\n${page.text}`.trim();
}

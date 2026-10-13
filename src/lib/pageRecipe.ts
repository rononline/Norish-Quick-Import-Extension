import { getChromeRuntimeError } from "./chrome";

export interface PageRecipe {
  /** schema.org Recipe found in the page's JSON-LD, if any */
  jsonLd: Record<string, unknown> | null;
  /** Visible text of the page, for Norish's AI when there is no JSON-LD */
  text: string;
  title: string;
  url: string;
  /** Recipe photos as data URLs, fetched in the page (Norish may be blocked) */
  images: string[];
}

/**
 * Runs in the page (via chrome.scripting): returns the page's schema.org
 * Recipe and visible text. Must be self-contained – it is serialized.
 */
export async function readRecipeInPage(): Promise<PageRecipe> {
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

  // Photo URLs: the recipe's own images, else the page's share image
  const imageUrls: string[] = [];
  const addImage = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(addImage);
      return;
    }
    const raw =
      typeof value === "string"
        ? value
        : value && typeof value === "object"
          ? ((value as Record<string, unknown>).url ??
            (value as Record<string, unknown>).contentUrl)
          : null;
    if (typeof raw !== "string" || !raw) return;
    try {
      const absolute = new URL(raw, location.href).toString();
      if (!imageUrls.includes(absolute)) imageUrls.push(absolute);
    } catch {
      // not a URL
    }
  };
  if (jsonLd) addImage(jsonLd.image);
  if (!imageUrls.length) {
    addImage(
      document
        .querySelector('meta[property="og:image"]')
        ?.getAttribute("content"),
    );
  }

  // Fetched here, with the page's own session, so a site that turns Norish
  // away still hands over its photos. Several sizes of one photo are common:
  // take the first few that load.
  const images: string[] = [];
  for (const imageUrl of imageUrls) {
    if (images.length >= 3) break;
    try {
      const response = await fetch(imageUrl, { credentials: "include" });
      const blob = await response.blob();
      if (
        !response.ok ||
        !/^image\/(jpeg|png|webp|avif)$/.test(blob.type) ||
        blob.size > 8 * 1024 * 1024
      ) {
        continue;
      }
      images.push(
        await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        }),
      );
    } catch {
      // blocked or not an image: skip
    }
  }
  // One photo in several sizes would fill the gallery with copies: keep the
  // largest of the recipe's own images
  if (images.length > 1 && imageUrls.length > 1) {
    images.sort((a, b) => b.length - a.length);
    images.splice(1);
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
    images,
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
  const result = (await results[0]?.result) as PageRecipe | undefined;
  if (!result) throw new Error("Could not read this page");
  return result;
}

/**
 * Text for Norish's paste import: the page's JSON-LD recipe (with the page as
 * its source URL) or, without one, the page title, URL and visible text.
 */
export function pasteTextFor(page: PageRecipe): string {
  if (page.jsonLd) {
    const recipe: Record<string, unknown> = {
      "@context": "https://schema.org",
      ...page.jsonLd,
      url: typeof page.jsonLd.url === "string" ? page.jsonLd.url : page.url,
    };
    // The extension uploads the photos itself; Norish fetching them again
    // would fail on such sites, or add copies
    if (page.images.length) delete recipe.image;
    return JSON.stringify(recipe);
  }
  return `${page.title}\n${page.url}\n\n${page.text}`.trim();
}

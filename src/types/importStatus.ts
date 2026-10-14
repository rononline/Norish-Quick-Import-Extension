export type ImportStatusKind =
  | "loading"
  | "pending"
  | "parsing"
  | "success"
  | "error";

export interface StoredImport {
  status: ImportStatusKind;
  recipeId?: string;
  message?: string;
  timestamp?: number;
  /** When the import was queued; the poll timeout counts from here */
  startedAt?: number;
  /** "page": imported from the open page's content (paste import) */
  kind?: "url" | "page";
  /** The URL that was imported, to offer a retry from the page */
  url?: string;
  /** Photos (data URLs) to upload once Norish created the recipe */
  images?: string[];
  recipeName?: string;
  recipeImage?: string;
  alreadyExists?: boolean;
}

export function isImportInProgress(
  lastImport: StoredImport | undefined,
): boolean {
  return (
    !!lastImport?.recipeId &&
    (lastImport.status === "pending" || lastImport.status === "parsing")
  );
}

export type ShelfSortMode = "lastOpened" | "rating" | "readingDate" | "publicationYear";

function parseShelfSortMode(value: unknown): ShelfSortMode {
  return value === "rating" || value === "readingDate" || value === "publicationYear"
    ? value
    : "lastOpened";
}

function storageKey(userId: string): string {
  return `lector:shelf-sort:${userId || "anon"}`;
}

export function readShelfSortMode(userId: string): ShelfSortMode {
  try {
    return parseShelfSortMode(localStorage.getItem(storageKey(userId)));
  } catch {
    return "lastOpened";
  }
}

export function saveShelfSortMode(userId: string, mode: ShelfSortMode): void {
  try {
    localStorage.setItem(storageKey(userId), parseShelfSortMode(mode));
  } catch {
    // Sorting still works when browser storage is unavailable.
  }
}

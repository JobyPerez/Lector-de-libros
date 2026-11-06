import type { ReaderTocEntry } from "../../app/api";

export type ChapterBoundaryLevel = 1 | 2 | 3;

export function parseChapterBoundaryLevel(value: unknown): ChapterBoundaryLevel {
  return value === 3 || value === "3" ? 3 : value === 2 || value === "2" ? 2 : 1;
}

function storageKey(bookId: string, userId: string): string {
  return `lector:chapter-boundary-level:${userId || "anon"}:${bookId}`;
}

export function readChapterBoundaryLevel(bookId: string, userId: string): ChapterBoundaryLevel {
  try {
    return parseChapterBoundaryLevel(localStorage.getItem(storageKey(bookId, userId)));
  } catch {
    return 1;
  }
}

export function saveChapterBoundaryLevel(bookId: string, userId: string, level: ChapterBoundaryLevel): void {
  if (!bookId) return;
  try {
    localStorage.setItem(storageKey(bookId, userId), String(parseChapterBoundaryLevel(level)));
  } catch {
    // The selector still works when browser storage is unavailable.
  }
}

export function nextChapterBoundaryPage(
  toc: ReaderTocEntry[],
  pageNumber: number,
  paragraphNumber: number,
  level: ChapterBoundaryLevel,
  totalPages: number
): number {
  const next = toc
    .filter((entry) => entry.level <= level && (
      entry.pageNumber > pageNumber
      || (entry.pageNumber === pageNumber && entry.paragraphNumber > paragraphNumber)
    ))
    .sort((left, right) => left.pageNumber - right.pageNumber || left.paragraphNumber - right.paragraphNumber)[0];
  return next?.pageNumber ?? totalPages;
}

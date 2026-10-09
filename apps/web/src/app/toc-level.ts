import { useCallback, useEffect, useState } from "react";

import { useAuthStore } from "./auth-store";

export const TOC_MIN_LEVEL = 1;
export const TOC_DEFAULT_MAX_LEVEL = 2;
export const TOC_MAX_LEVEL = 3;

export type TocMaxLevel = 1 | 2 | 3;

export const TOC_MAX_LEVEL_OPTIONS: TocMaxLevel[] = [1, 2, 3];

export function parseTocMaxLevel(raw: unknown): TocMaxLevel {
  const value = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (value === 1 || value === 2 || value === 3) return value;
  return TOC_DEFAULT_MAX_LEVEL;
}

export function filterTocByMaxLevel<T extends { level: number }>(items: T[], maxLevel: TocMaxLevel): T[] {
  return items.filter((item) => item.level <= maxLevel);
}

function tocMaxLevelStorageKey(userId: string, bookId: string): string {
  return `lector:toc-max-level:${userId || "anon"}:${bookId}`;
}

export function readTocMaxLevel(bookId: string, userId = ""): TocMaxLevel {
  if (!bookId) return TOC_DEFAULT_MAX_LEVEL;
  try {
    return parseTocMaxLevel(localStorage.getItem(tocMaxLevelStorageKey(userId, bookId)));
  } catch {
    return TOC_DEFAULT_MAX_LEVEL;
  }
}

export function useTocMaxLevel(bookId: string): [TocMaxLevel, (level: TocMaxLevel) => void] {
  const userId = useAuthStore((state) => state.user?.userId) ?? "";
  const [maxLevel, setMaxLevel] = useState<TocMaxLevel>(() => readTocMaxLevel(bookId, userId));

  useEffect(() => {
    setMaxLevel(readTocMaxLevel(bookId, userId));
  }, [bookId, userId]);

  const update = useCallback(
    (level: TocMaxLevel) => {
      const parsed = parseTocMaxLevel(level);
      setMaxLevel(parsed);
      if (!bookId) return;
      try {
        localStorage.setItem(tocMaxLevelStorageKey(userId, bookId), String(parsed));
      } catch {
        /* Storage may be unavailable. */
      }
    },
    [bookId, userId]
  );

  return [maxLevel, update];
}

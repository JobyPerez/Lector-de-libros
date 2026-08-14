export type TocItemLike = {
  chapterId?: string | null;
  level: number;
  pageNumber?: number;
  paragraphNumber?: number;
  sequenceNumber?: number | null;
  title: string;
};

/**
 * Returns the section title pre-pended with parent section titles separated by " > ",
 * if the section is a lower-level section with parents in the TOC.
 */
export function formatSectionTitleWithAncestors(
  target: TocItemLike | null | undefined,
  toc: TocItemLike[] | null | undefined,
  separator = " > "
): string | null {
  if (!target) {
    return null;
  }

  if (!toc || toc.length === 0) {
    return target.title;
  }

  // Find target in toc
  let targetIndex = -1;
  if (target.chapterId) {
    targetIndex = toc.findIndex((item) => item.chapterId === target.chapterId);
  }

  if (targetIndex === -1) {
    targetIndex = toc.findIndex((item) => (
      item.title === target.title &&
      item.level === target.level &&
      (target.pageNumber === undefined || item.pageNumber === target.pageNumber)
    ));
  }

  if (targetIndex <= 0) {
    return target.title;
  }

  const ancestorTitles: string[] = [];
  let currentLevel = target.level;

  for (let i = targetIndex - 1; i >= 0; i--) {
    const item = toc[i];
    if (item && item.level < currentLevel) {
      ancestorTitles.unshift(item.title);
      currentLevel = item.level;
    }
  }

  if (ancestorTitles.length === 0) {
    return target.title;
  }

  return [...ancestorTitles, target.title].join(separator);
}

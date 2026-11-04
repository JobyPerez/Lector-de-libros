import type { ReaderHighlight, ReaderNavigationSummary, ReaderNote, ReaderTocEntry } from "../../app/api";
import type { ReaderNavigationListItem } from "./ReaderFloatingPanels";

export function tocEntryKey(entry: ReaderTocEntry) {
  return entry.chapterId ?? `${entry.pageNumber}:${entry.paragraphNumber}:${entry.sequenceNumber ?? "na"}:${entry.title}`;
}

function excerptPreview(value: string | null | undefined, fallback: string) {
  const normalizedValue = value?.replace(/\s+/gu, " ").trim();
  if (!normalizedValue) return fallback;
  return normalizedValue.length > 120 ? `${normalizedValue.slice(0, 117).trimEnd()}...` : normalizedValue;
}

export function notePreview(note: Pick<ReaderNote, "highlightedText" | "noteText">) {
  return excerptPreview(note.highlightedText ?? note.noteText, "Nota sin extracto");
}

export function highlightPreview(highlight: Pick<ReaderHighlight, "highlightedText">) {
  return excerptPreview(highlight.highlightedText, "Resaltado sin texto");
}

// The content is shared; each screen supplies its own location and selection handlers.
// Omitting paragraphNumber marks annotations on the whole page (the page editor).
export function buildReaderNavigationItems(
  navigation: Pick<ReaderNavigationSummary, "toc" | "bookmarks" | "notes" | "highlights"> | undefined,
  location: { activeTocEntryKey: string | null; pageNumber: number; paragraphNumber?: number }
): ReaderNavigationListItem[] {
  const isActive = (item: { pageNumber: number; paragraphNumber: number | null }) => (
    item.pageNumber === location.pageNumber
    && (location.paragraphNumber === undefined || (item.paragraphNumber ?? location.paragraphNumber) === location.paragraphNumber)
  );
  const tocItems: ReaderNavigationListItem[] = (navigation?.toc ?? []).map((entry) => ({
    chapterId: entry.chapterId ?? null,
    isActive: location.activeTocEntryKey === tocEntryKey(entry),
    key: `toc:${tocEntryKey(entry)}`,
    level: entry.level,
    pageNumber: entry.pageNumber,
    paragraphNumber: entry.paragraphNumber,
    title: entry.title,
    type: "toc"
  }));
  const bookmarkItems: ReaderNavigationListItem[] = (navigation?.bookmarks ?? []).map((bookmark) => ({
    authorLabel: bookmark.userDisplayName?.trim() || (bookmark.username ? `@${bookmark.username}` : null),
    bookmarkId: bookmark.bookmarkId,
    createdAt: bookmark.createdAt,
    isActive: isActive(bookmark),
    isOwnedByCurrentUser: bookmark.isOwnedByCurrentUser ?? true,
    key: `bookmark:${bookmark.bookmarkId}`,
    pageNumber: bookmark.pageNumber,
    paragraphNumber: bookmark.paragraphNumber,
    sharedWithUserIds: bookmark.sharedWithUserIds ?? [],
    title: "Marcador guardado",
    type: "bookmark",
    visibilitySource: bookmark.visibilitySource ?? (bookmark.isOwnedByCurrentUser === false ? "DIRECT" : "OWN")
  }));
  const noteItems: ReaderNavigationListItem[] = (navigation?.notes ?? []).map((note) => ({
    authorLabel: note.userDisplayName?.trim() || (note.username ? `@${note.username}` : null),
    color: note.highlightColor,
    excerpt: notePreview(note),
    isActive: isActive(note),
    isReadOnly: note.isOwnedByCurrentUser === false,
    key: `note:${note.noteId}`,
    noteId: note.noteId,
    noteText: note.noteText,
    pageNumber: note.pageNumber,
    paragraphNumber: note.paragraphNumber ?? 1,
    sharedWithUserIds: note.sharedWithUserIds ?? [],
    type: "note"
  }));
  const notedHighlightIds = new Set((navigation?.notes ?? []).map((note) => note.highlightId).filter(Boolean));
  const highlightItems: ReaderNavigationListItem[] = (navigation?.highlights ?? [])
    .filter((highlight) => !notedHighlightIds.has(highlight.highlightId))
    .map((highlight) => ({
      color: highlight.color,
      excerpt: highlightPreview(highlight),
      highlightId: highlight.highlightId,
      isActive: isActive(highlight),
      key: `highlight:${highlight.highlightId}`,
      pageNumber: highlight.pageNumber,
      paragraphNumber: highlight.paragraphNumber,
      type: "highlight"
    }));

  const sortWeight = { bookmark: 1, highlight: 2, note: 3, toc: 0 } as const;
  return [...tocItems, ...bookmarkItems, ...highlightItems, ...noteItems].sort((left, right) => (
    left.pageNumber - right.pageNumber
    || left.paragraphNumber - right.paragraphNumber
    || sortWeight[left.type] - sortWeight[right.type]
  ));
}

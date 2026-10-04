import type { ParagraphContent, ReaderAudioBlockParagraph } from "../../app/api";

export function buildAudioBlockTimings(paragraphs: ReaderAudioBlockParagraph[], durationMs: number) {
  const durations = paragraphs.map((paragraph) => Number.isFinite(paragraph.durationMs) && (paragraph.durationMs ?? 0) > 0 ? paragraph.durationMs! : 0);
  const hasDurations = durations.length > 0 && durations.every((duration) => duration > 0);
  const totalDuration = hasDurations ? durations.reduce((sum, duration) => sum + duration, 0)
    : Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 18_000;
  const weights = paragraphs.map((paragraph, index) => hasDurations ? durations[index]!
    : Number.isFinite(paragraph.audioByteLength) && (paragraph.audioByteLength ?? 0) > 0
      ? Math.max(paragraph.audioByteLength!, 256) : Math.max(paragraph.textLength, 48));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  return paragraphs.map((paragraph, index) => {
    const startMs = cursor;
    cursor += index === paragraphs.length - 1 ? Math.max(totalDuration - cursor, 0)
      : Math.round(totalDuration * weights[index]! / totalWeight);
    return { ...paragraph, startMs, endMs: cursor };
  });
}

export function isReadable(paragraph: Pick<ParagraphContent, "readAloud" | "paragraphText" | "active">) {
  return paragraph.active !== false && paragraph.readAloud !== false && paragraph.paragraphText.trim().length > 0;
}

export async function findReadableParagraph(
  loadPage: (pageNumber: number) => Promise<ParagraphContent[]>,
  totalPages: number,
  pageNumber: number,
  sequenceNumber: number,
  direction: -1 | 1 = 1,
  inclusive = false
): Promise<{ paragraph: ParagraphContent; pageNumber: number } | null> {
  for (let page = pageNumber; page >= 1 && page <= totalPages; page += direction) {
    const paragraphs = (await loadPage(page)).filter((paragraph) => isReadable(paragraph)
      && (direction === 1
        ? inclusive ? paragraph.sequenceNumber >= sequenceNumber : paragraph.sequenceNumber > sequenceNumber
        : inclusive ? paragraph.sequenceNumber <= sequenceNumber : paragraph.sequenceNumber < sequenceNumber));
    const paragraph = direction === 1 ? paragraphs[0] : paragraphs[paragraphs.length - 1];
    if (paragraph) return { paragraph, pageNumber: page };
  }
  return null;
}

// Only legacy responses lack a cursor. Use the actual last paragraph, not the requested count.
export function nextAudioCursor(block: { nextSequenceNumber?: number | null | undefined; paragraphs: Array<{ sequenceNumber: number }> }) {
  if (block.nextSequenceNumber !== undefined) return block.nextSequenceNumber;
  const last = block.paragraphs[block.paragraphs.length - 1];
  return last ? last.sequenceNumber + 1 : null;
}

type Bbox = { left: number; top: number; width: number; height: number };

export function readingRowLayout(boxes: Array<Bbox | null>) {
  if (!boxes.length || boxes.some((box) => !box || !Object.values(box).every(Number.isFinite) || box.width <= 0 || box.height <= 0)) return null;
  const valid = boxes as Bbox[];
  const left = Math.min(...valid.map((box) => box.left));
  const right = Math.max(...valid.map((box) => box.left + box.width));
  const span = right - left;
  if (!Number.isFinite(span) || span <= 0) return null;
  const gaps = valid.slice(1).map((box, index) => Math.max(0, box.left - (valid[index]!.left + valid[index]!.width)) / span);
  return {
    columns: valid.map((box) => `minmax(0, ${box.width / span}fr)`).join(" "),
    gap: Math.min(.08, gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0)
  };
}

export function applyReadingElementLayout(document: Document, paragraphs: ParagraphContent[]) {
  document.querySelectorAll<HTMLElement>("[data-paragraph-number]").forEach((node) => {
    const paragraph = paragraphs.find((entry) => entry.paragraphNumber === Number(node.dataset.paragraphNumber));
    if (!paragraph) return;
    if (paragraph.role) node.dataset.elementRole = paragraph.role;
    node.dataset.readAloud = String(paragraph.readAloud !== false);
    if (paragraph.geometry) node.dataset.elementGeometry = JSON.stringify(paragraph.geometry);
  });
  document.querySelectorAll<HTMLElement>(".reader-reading-row").forEach((row) => {
    if (row.dataset.layoutId) return;
    const boxes = Array.from(row.children).map((block) => {
      // Peripheral elements should not inflate the body column's union box.
      const bodyBoxes = Array.from(block.querySelectorAll<HTMLElement>("[data-paragraph-number]"))
        .map((node) => paragraphs.find((paragraph) => paragraph.paragraphNumber === Number(node.dataset.paragraphNumber)))
        .filter((paragraph) => paragraph && !["header", "footer", "pageNumber"].includes(paragraph.role ?? ""))
        .flatMap((paragraph) => paragraph?.geometry ? [paragraph.geometry.bbox] : []);
      if (bodyBoxes.length) {
        const left = Math.min(...bodyBoxes.map((box) => box.left));
        const top = Math.min(...bodyBoxes.map((box) => box.top));
        return { left, top, width: Math.max(...bodyBoxes.map((box) => box.left + box.width)) - left, height: Math.max(...bodyBoxes.map((box) => box.top + box.height)) - top };
      }
      try {
        return JSON.parse((block as HTMLElement).dataset.elementGeometry ?? "null")?.bbox ?? null;
      } catch { return null; }
    });
    const layout = readingRowLayout(boxes);
    if (!layout) return;
    row.style.setProperty("--reader-row-columns", layout.columns);
    row.style.setProperty("--reader-row-gap", `${layout.gap * 100}%`);
  });
  document.querySelectorAll<HTMLElement>("figure[data-paragraph-number]").forEach((figure) => {
    const explicitWidth = Number(figure.dataset.imageWidth);
    if (Number.isFinite(explicitWidth) && explicitWidth >= 1 && explicitWidth <= 100) {
      figure.style.setProperty("--reader-image-width", `${explicitWidth}%`);
      return;
    }
    const paragraph = paragraphs.find((entry) => entry.paragraphNumber === Number(figure.dataset.paragraphNumber));
    const block = figure.closest<HTMLElement>(".reader-reading-block");
    if (!paragraph?.geometry || !block) return;
    try {
      const width = JSON.parse(block.dataset.elementGeometry ?? "null")?.bbox?.width;
      if (Number.isFinite(width) && width > 0) {
        figure.style.setProperty("--reader-image-width", `${Math.min(1, paragraph.geometry.bbox.width / width) * 100}%`);
      }
    } catch { /* Legacy pages can lack geometry. */ }
  });
}

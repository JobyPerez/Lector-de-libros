import type { Geometry, PageElementRole } from "./page-elements.js";

export type OcrMarginHints = { headers?: readonly string[]; footers?: readonly string[] };
type Box = Geometry["bbox"];
export type MarginItem = { role: PageElementRole; box: Box | null };

function normalizeHint(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function inferHintedMargin(text: string, box: Box | null, body: readonly Box[], hints?: OcrMarginHints): "header" | "footer" | undefined {
  const normalized = normalizeHint(text);
  if (!box || !normalized || normalized.length > 120 || normalized.split(" ").length > 12 || box.height > 0.035) return;
  // Repeated chapter labels can still be genuine section titles.
  if (/\b(?:chapter|capitulo|capitolo|parte|part|prologo|prologue|prefacio|preface|introduccion|introduzione|introduction|epilogo|epilogue)\b/u.test(normalized)) return;
  const matches = (values?: readonly string[]) => values?.some((hint) => normalizeHint(hint) === normalized);
  if (box.top <= 0.12 && box.top + box.height <= 0.15 && matches(hints?.headers)) {
    const next = body.filter((candidate) => candidate.top + candidate.height > box.top && candidate.width >= 0.25 && candidate.height >= 0.06)
      .sort((a, b) => a.top - b.top)[0];
    const gap = next ? next.top - box.top - box.height : -1;
    if (gap >= 0.012 && gap <= 0.1) return "header";
  }
  if (box.top >= 0.85 && matches(hints?.footers)) return "footer";
}

export function marginAlignment(role: PageElementRole, box: Box | null): "center" | "right" | undefined {
  if (role === "pageNumber") return "right";
  if (role === "footer" || (role === "header" && box && Math.abs(box.left + box.width / 2 - 0.5) <= 0.1)) return "center";
}

// Only adjacent isolated margin runs are reordered; body order and existing rows stay intact.
export function pairBottomMargins<T extends { readingRowId?: string }>(items: readonly T[], describe: (item: T) => MarginItem | null, prefix: string): T[] {
  const result = items.map((item) => ({ ...item }));
  const reserved = new Set(items.map((item) => item.readingRowId));
  const eligible = (item: T) => {
    const info = describe(item);
    return info && ["footer", "pageNumber"].includes(info.role) && info.box && info.box.top >= 0.85 ? info.box : null;
  };
  let serial = 1;
  for (let index = 0; index < result.length - 1; index += 1) {
    if (result[index]!.readingRowId || result[index + 1]!.readingRowId) continue;
    const a = eligible(result[index]!);
    const b = eligible(result[index + 1]!);
    if (!a || !b) continue;
    const overlapX = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    const overlapY = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
    const delta = Math.abs(a.top + a.height / 2 - b.top - b.height / 2);
    const tiltTolerance = 0.003;
    if (overlapX > 0 || (overlapY < 0 && delta > Math.max(a.height, b.height) * 0.9 + tiltTolerance)) continue;
    let row: string;
    do { row = `${prefix}-margin-row-${serial++}`; } while (reserved.has(row));
    reserved.add(row);
    if (a.left > b.left) [result[index], result[index + 1]] = [result[index + 1]!, result[index]!];
    result[index]!.readingRowId = row;
    result[index + 1]!.readingRowId = row;
    index += 1;
  }
  return result;
}

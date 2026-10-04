export const readingBlockMarker = /^:::block ([a-zA-Z0-9_-]{1,80})(?: row=([a-zA-Z0-9_-]{1,80}))?\s*$/u;

import type { ParagraphElementMetadata } from "../../app/api";

export type ReadingBlock = { id: string | null; rowId?: string; text: string; paragraphIds: (string | null)[]; paragraphMetadata?: ParagraphElementMetadata[] };

export function defaultElementMetadata(): ParagraphElementMetadata {
  return { role: "body", readAloud: true, geometry: null };
}

export function readingElements(blocks: ReadingBlock[]) {
  return blocks.flatMap((block, blockIndex) => paragraphLines(block.text).map((text, lineIndex) => ({
    key: block.paragraphIds[lineIndex] ?? `${block.id ?? "legacy"}:${lineIndex}`, blockIndex, lineIndex, text,
    paragraphId: block.paragraphIds[lineIndex] ?? null,
    ...defaultElementMetadata(), ...block.paragraphMetadata?.[lineIndex]
  })));
}

export function readingMetadata(blocks: ReadingBlock[]): ParagraphElementMetadata[] {
  return readingElements(blocks).map(({ role, readAloud, geometry }) => ({ role, readAloud, geometry: geometry ?? null }));
}

export function pageElementsForSave(blocks: ReadingBlock[]) {
  const elements = readingElements(blocks);
  const ids = elements.map((element) => element.paragraphId);
  if (ids.some((id) => !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) || new Set(ids).size !== ids.length) return null;
  return elements.map(({ paragraphId, role, readAloud, geometry }) => ({ paragraphId: paragraphId!, role, readAloud, geometry: geometry ?? null }));
}

export type ReadingDraftVersion = { identity: string; updatedAt: string | null | undefined };

export function readingDraftSyncAction(initialized: ReadingDraftVersion | null, remote: ReadingDraftVersion, dirty: boolean): "initialize" | "preserve" | "conflict" {
  if (initialized?.identity !== remote.identity) return "initialize";
  if (initialized.updatedAt === remote.updatedAt) return "preserve";
  return dirty ? "conflict" : "initialize";
}

export function paragraphLines(text: string): string[] {
  return text.replace(/\r/g, "").split("\n").filter((line) => line.trim() && !readingBlockMarker.test(line));
}

export function parseReadingBlocks(text: string, ids: (string | null)[] = [], metadata?: ParagraphElementMetadata[]): ReadingBlock[] {
  const lineCount = paragraphLines(text).length;
  if (metadata !== undefined && metadata.length !== lineCount) {
    throw new Error(`Los metadatos de ${metadata.length} parrafos no coinciden con los ${lineCount} elementos del texto. La edicion y el guardado estan bloqueados para conservar los tipos y las marcas de lectura.`);
  }
  const alignedIds = lineCount === ids.length ? ids : [];
  const blocks: ReadingBlock[] = [];
  let current: ReadingBlock = { id: null, text: "", paragraphIds: [], ...(metadata ? { paragraphMetadata: [] } : {}) };
  const alignedMetadata = metadata ?? [];
  let offset = 0;
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const marker = line.match(readingBlockMarker);
    if (marker) {
      if (current.id || current.text.trim()) blocks.push(current);
      current = { id: marker[1]!, ...(marker[2] ? { rowId: marker[2] } : {}), text: "", paragraphIds: [], ...(metadata ? { paragraphMetadata: [] } : {}) };
    } else {
      current.text += `${current.text ? "\n" : ""}${line}`;
      if (line.trim()) {
        current.paragraphIds.push(alignedIds[offset] ?? null);
        current.paragraphMetadata?.push(alignedMetadata[offset] ?? defaultElementMetadata());
        offset++;
      }
    }
  }
  if (current.id || current.text.trim() || !blocks.length) blocks.push(current);
  return blocks;
}

export function serializeReadingBlocks(blocks: ReadingBlock[]): string {
  return blocks.map((block) => `${block.id ? `:::block ${block.id}${block.rowId ? ` row=${block.rowId}` : ""}\n` : ""}${block.text}`).join("\n");
}

export function normalizeReadingRows(blocks: ReadingBlock[]): ReadingBlock[] {
  const reserved = new Set(blocks.map((block) => block.rowId).filter(Boolean));
  const seen = new Set<string>();
  // Track original IDs so each recurring contiguous segment shares one new ID.
  let previous: string | undefined;
  let rowId: string | undefined;
  return blocks.map((block) => {
    if (block.rowId !== previous) {
      rowId = block.rowId;
      if (rowId && seen.has(rowId)) {
        do { rowId = crypto.randomUUID(); } while (reserved.has(rowId));
        reserved.add(rowId);
      }
      if (block.rowId) seen.add(block.rowId);
    }
    previous = block.rowId;
    return rowId && rowId !== block.rowId ? { ...block, rowId } : block;
  });
}

export function explicitReadingBlocks(blocks: ReadingBlock[]): ReadingBlock[] {
  return blocks.map((block) => ({ ...block, id: block.id ?? crypto.randomUUID() }));
}

export function editReadingBlock(block: ReadingBlock, text: string): ReadingBlock {
  if (block.paragraphMetadata) {
    // Reuse the identity mapping with positional tokens, including unsaved lines.
    const { paragraphMetadata, ...plainBlock } = block;
    const mapped = editReadingBlock({ ...plainBlock, paragraphIds: paragraphLines(block.text).map((_, index) => String(index)) }, text);
    return { ...block, text, paragraphIds: mapped.paragraphIds.map((index) => index === null ? null : block.paragraphIds[Number(index)] ?? null),
      paragraphMetadata: mapped.paragraphIds.map((index) => index === null ? defaultElementMetadata() : paragraphMetadata[Number(index)] ?? defaultElementMetadata()) };
  }
  const before = paragraphLines(block.text);
  const after = paragraphLines(text);
  if (before.length === after.length) {
    const oldPositions = new Map<string, number[]>();
    const newPositions = new Map<string, number[]>();
    before.forEach((line, index) => oldPositions.set(line, [...(oldPositions.get(line) ?? []), index]));
    after.forEach((line, index) => newPositions.set(line, [...(newPositions.get(line) ?? []), index]));
    const hasMovement = after.some((line, index) => {
      const positions = oldPositions.get(line);
      return positions?.length === 1 && newPositions.get(line)?.length === 1 && positions[0] !== index;
    });
    const ids = after.map((line, index) => {
      const positions = oldPositions.get(line);
      if (positions?.length === 1 && newPositions.get(line)?.length === 1) {
        return block.paragraphIds[positions[0]!] ?? null;
      }
      if (positions || newPositions.get(line)!.length > 1 || hasMovement) return null;
      return block.paragraphIds[index] ?? null;
    });
    // An entirely unchanged duplicate line still has a known position.
    if (before.every((line, index) => line === after[index])) return { ...block, text };
    return { ...block, text, paragraphIds: ids };
  }
  // Only unchanged edges are unambiguous after inserting/deleting lines.
  const ids: (string | null)[] = after.map(() => null);
  let start = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) {
    ids[start] = block.paragraphIds[start] ?? null;
    start++;
  }
  let oldEnd = before.length - 1;
  let newEnd = after.length - 1;
  while (oldEnd >= start && newEnd >= start && before[oldEnd] === after[newEnd]) {
    ids[newEnd--] = block.paragraphIds[oldEnd--] ?? null;
  }
  return { ...block, text, paragraphIds: ids };
}

export function splitReadingBlock(block: ReadingBlock, cursor: number): ReadingBlock[] | null {
  const start = block.text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const left = block.text.slice(0, start).trimEnd();
  const right = block.text.slice(start);
  if (!left.trim() || !right.trim()) return null;
  const count = paragraphLines(left).length;
  return [
    { ...block, text: left, paragraphIds: block.paragraphIds.slice(0, count), ...(block.paragraphMetadata ? { paragraphMetadata: block.paragraphMetadata.slice(0, count) } : {}) },
    { ...block, id: crypto.randomUUID(), text: right, paragraphIds: block.paragraphIds.slice(count), ...(block.paragraphMetadata ? { paragraphMetadata: block.paragraphMetadata.slice(count) } : {}) }
  ];
}

export function joinReadingBlocks(block: ReadingBlock, following: ReadingBlock): ReadingBlock {
  return { ...block, text: `${block.text}\n${following.text}`, paragraphIds: [...block.paragraphIds, ...following.paragraphIds],
    ...(block.paragraphMetadata || following.paragraphMetadata ? { paragraphMetadata: readingMetadata([block, following]) } : {}) };
}

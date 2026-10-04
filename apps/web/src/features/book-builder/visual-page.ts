import type { BookPageResponse, PageElementGeometry, VisualBlock, VisualCompositeContent, VisualLayoutNode, VisualPageDocument } from "../../app/api";
import { buildEditableTextFromHtmlContent } from "./ocr-preview";

export type VisualContainer = Extract<VisualLayoutNode, { children: VisualLayoutNode[] }>;
export type VisualPreset = "one-column" | "two-columns" | "two-by-two" | "rows";
export type VisualHistory = { past: VisualPageDocument[]; present: VisualPageDocument; future: VisualPageDocument[] };

export function isCenteredFooterRow(node: VisualLayoutNode, blocks: readonly VisualBlock[]): boolean {
  if (node.type !== "row" || node.content !== undefined || node.weights !== undefined || node.children.length !== 2) return false;
  const singleBlock = (child: VisualLayoutNode): VisualBlock | undefined => {
    if (child.type === "block") return blocks.find((block) => block.id === child.blockId);
    return child.type === "column" && child.content === undefined && child.children.length === 1 ? singleBlock(child.children[0]!) : undefined;
  };
  const footer = singleBlock(node.children[0]!);
  const number = singleBlock(node.children[1]!);
  if (footer?.role !== "footer" || number?.role !== "pageNumber") return false;
  const boxes = [footer.geometry?.bbox, number.geometry?.bbox];
  if (!boxes.every((box) => box && [box.left, box.top, box.width, box.height].every(Number.isFinite)
    && box.left >= 0 && box.top >= .85 && box.width > 0 && box.height > 0
    && box.left + box.width <= 1.000001 && box.top + box.height <= 1.000001)) return false;
  const [a, b] = boxes as [NonNullable<VisualBlock["geometry"]>["bbox"], NonNullable<VisualBlock["geometry"]>["bbox"]];
  if (Math.abs(a.left + a.width / 2 - .5) > .12 || b.left + b.width / 2 < .7) return false;
  // Allow a small normalized-page tilt when the two short labels do not overlap vertically.
  return Math.max(a.top, b.top) <= Math.min(a.top + a.height, b.top + b.height)
    || Math.abs(a.top + a.height / 2 - b.top - b.height / 2) <= Math.max(a.height, b.height) + .015;
}

export function flattenVisualLayout(node: VisualLayoutNode): VisualLayoutNode[] {
  return [node, ...(node.type === "block" ? [] : node.children.flatMap(flattenVisualLayout))];
}

export function orderedVisualBlocks(doc: VisualPageDocument, includeInactive = true): VisualBlock[] {
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  return flattenVisualLayout(doc.layout).flatMap((node) => {
    const block = node.type === "block" ? blocks.get(node.blockId) : undefined;
    return block && (includeInactive || block.active) ? [block] : [];
  });
}

export function compositeForBlock(doc: VisualPageDocument, id: string): VisualContainer | undefined {
  return flattenVisualLayout(doc.layout).find((node): node is VisualContainer => node.type !== "block" && Boolean(node.content) && node.children.some((child) => child.type === "block" && child.blockId === id));
}

// Ordinary containers are transparent; a composite occupies one numbering slot.
export function visualUnits(doc: VisualPageDocument, includeInactive = true): VisualLayoutNode[] {
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  function visit(node: VisualLayoutNode): VisualLayoutNode[] {
    if (node.type === "block") return blocks.has(node.blockId) && (includeInactive || blocks.get(node.blockId)!.active) ? [node] : [];
    if (node.content) return includeInactive || node.children.some((child) => child.type === "block" && blocks.get(child.blockId)?.active) ? [node] : [];
    return node.children.flatMap(visit);
  }
  return visit(doc.layout);
}

function validCompositeContent(content: VisualCompositeContent): boolean {
  return Boolean(content && typeof content === "object" && ["text", "heading"].includes(content.kind)
    && Object.keys(content).every((key) => ["kind", "separator", "includeInToc", "headingLevel", "alignment", "fontScale", "origins"].includes(key))
    && ["space", "line", "paragraph"].includes(content.separator) && typeof content.includeInToc === "boolean"
    && (content.headingLevel === undefined || Number.isInteger(content.headingLevel) && content.headingLevel >= 1 && content.headingLevel <= 6)
    && (content.alignment === undefined || ["left", "center", "right"].includes(content.alignment))
    && (content.fontScale === undefined || Number.isFinite(content.fontScale) && content.fontScale >= 0.5 && content.fontScale <= 3)
    && (content.origins === undefined || Array.isArray(content.origins) && content.origins.every((origin) => origin && typeof origin === "object"
      && Object.keys(origin).every((key) => ["leafId", "parentId", "index", "weight"].includes(key))
      && typeof origin.leafId === "string" && Boolean(origin.leafId.trim()) && typeof origin.parentId === "string" && Boolean(origin.parentId.trim())
      && Number.isInteger(origin.index) && origin.index >= 0 && (origin.weight === undefined || Number.isFinite(origin.weight) && origin.weight > 0))
      && new Set(content.origins.map((origin) => origin.leafId)).size === content.origins.length));
}

function compositeOriginsMatch(node: VisualContainer): boolean {
  const origins = node.content?.origins;
  return origins === undefined || origins.length === node.children.length && node.children.every((child, index) => child.type === "block" && child.id === origins[index]!.leafId);
}

export function mergeVisualBlocks(doc: VisualPageDocument, ids: string[], content: VisualCompositeContent): VisualPageDocument {
  if (ids.length < 2 || new Set(ids).size !== ids.length) throw new Error("Selecciona al menos dos bloques distintos para unir.");
  if (!content || typeof content !== "object") throw new Error("Los metadatos del contenido compuesto no son validos.");
  const { origins: _providedOrigins, ...metadata } = content;
  if (!validCompositeContent(metadata)) throw new Error("Los metadatos del contenido compuesto no son validos.");
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  for (const id of ids) {
    const block = blocks.get(id);
    if (!block || !block.active || !["text", "heading"].includes(block.kind)) throw new Error("Solo se pueden unir bloques activos de texto o titulo, nunca imagenes.");
    if (compositeForBlock(doc, id)) throw new Error("Separa primero el contenido compuesto antes de volver a unir sus bloques.");
  }
  const nodes = flattenVisualLayout(doc.layout);
  const leaves = nodes.filter((node) => node.type === "block");
  const selected = new Set(ids);
  const positions = leaves.flatMap((leaf, index) => selected.has(leaf.blockId) ? [index] : []);
  if (positions.length !== ids.length || positions.at(-1)! - positions[0]! + 1 !== ids.length) throw new Error("Los bloques seleccionados deben ser consecutivos en el orden completo de la pagina, incluidos los inactivos.");
  const children = leaves.slice(positions[0], positions.at(-1)! + 1);
  const first = children[0]!;
  const origins = children.map((child) => {
    const parent = nodes.find((node): node is VisualContainer => node.type !== "block" && node.children.some((leaf) => leaf.id === child.id));
    if (!parent) throw new Error("No se encuentra el contenedor de la seleccion.");
    const index = parent.children.findIndex((leaf) => leaf.id === child.id);
    return { leafId: child.id, parentId: parent.id, index, ...(parent.weights ? { weight: parent.weights[index]! } : {}) };
  });
  const composite: VisualContainer = { id: crypto.randomUUID(), type: "column", children, content: { ...metadata, origins } };
  function visit(node: VisualLayoutNode): VisualLayoutNode {
    if (node.type === "block") return node;
    const next: VisualLayoutNode[] = [];
    const weights: number[] = [];
    node.children.forEach((child, index) => {
      if (child.type === "block" && selected.has(child.blockId)) {
        if (child.id !== first.id) return;
        next.push(composite);
      } else next.push(visit(child));
      weights.push(node.weights?.[index] ?? 1);
    });
    return { ...node, children: next, ...(node.weights ? { weights } : {}) };
  }
  return { ...doc, layout: visit(doc.layout) };
}

export function updateVisualNode(node: VisualLayoutNode, id: string, update: (node: VisualLayoutNode) => VisualLayoutNode): VisualLayoutNode {
  if (node.id === id) {
    let next = update(node);
    if (node.type !== "block" && node.content?.origins && next.type !== "block" && next.content) {
      next = { ...next, content: { ...next.content, origins: node.content.origins } };
    }
    if (node.type !== "block" && node.content && (next.type !== "column" || !next.content || !validCompositeContent(next.content)
      || next.children.length !== node.children.length || next.children.some((child, index) => child !== node.children[index]))) return node;
    return next;
  }
  return node.type === "block" || node.content ? node : { ...node, children: node.children.map((child) => updateVisualNode(child, id, update)) };
}

export function updateVisualBlock(doc: VisualPageDocument, id: string, patch: Partial<Omit<VisualBlock, "id">>): VisualPageDocument {
  if (patch.kind === "image" && compositeForBlock(doc, id)) return doc;
  return { ...doc, blocks: doc.blocks.map((block) => {
    if (block.id !== id) return block;
    const next = { ...block, ...patch };
    if (next.kind !== "image") { delete next.source; delete next.imageWidth; }
    if (next.kind !== "heading") { delete next.headingLevel; next.includeInToc = false; }
    return next;
  }) };
}

// Repair references, not content: every atom (including annulled ones) has exactly one leaf.
export function normalizeVisualDocument(doc: VisualPageDocument): VisualPageDocument {
  const blockIds = new Set(doc.blocks.map((block) => block.id));
  const seen = new Set<string>();
  const nodeIds = new Set<string>();
  function visit(node: VisualLayoutNode): VisualLayoutNode | null {
    const id = nodeIds.has(node.id) ? crypto.randomUUID() : node.id;
    nodeIds.add(id);
    if (node.type === "block") {
      if (!blockIds.has(node.blockId) || seen.has(node.blockId)) return null;
      seen.add(node.blockId);
      return { ...node, id };
    }
    const children: VisualLayoutNode[] = [];
    const weights: number[] = [];
    node.children.forEach((child, index) => {
      const next = visit(child);
      if (!next) return;
      children.push(next);
      const weight = node.weights?.[index];
      weights.push(weight && Number.isFinite(weight) && weight > 0 ? weight : 1);
    });
    return { ...node, id, children, ...(node.weights ? { weights } : {}), gap: Math.max(0, Math.min(48, node.gap ?? 12)) };
  }
  let layout = visit(doc.layout) ?? { id: crypto.randomUUID(), type: "column" as const, children: [] };
  const missing = doc.blocks.filter((block) => !seen.has(block.id)).map((block) => ({ id: crypto.randomUUID(), type: "block" as const, blockId: block.id }));
  if (missing.length) {
    layout = layout.type === "block" || layout.content
      ? { id: crypto.randomUUID(), type: "column", children: [layout, ...missing] }
      : { ...layout, children: [...layout.children, ...missing], ...(layout.weights ? { weights: [...layout.weights, ...missing.map(() => 1)] } : {}) };
  }
  return { ...doc, layout };
}

// Index is a boundary in the destination's children BEFORE removing the moving node.
export function moveVisualNode(doc: VisualPageDocument, nodeId: string, parentId: string, index: number): VisualPageDocument {
  const nodes = flattenVisualLayout(doc.layout);
  const moving = nodes.find((node) => node.id === nodeId);
  const target = nodes.find((node) => node.id === parentId);
  if (target?.type !== "block" && target?.content || nodes.some((node) => node.type !== "block" && node.content && node.children.some((child) => child.id === nodeId))) return doc;
  if (!moving || !target || target.type === "block" || moving === doc.layout || flattenVisualLayout(moving).some((node) => node.id === parentId)) return doc;
  const oldParent = nodes.find((node) => node.type !== "block" && node.children.some((child) => child.id === nodeId)) as VisualContainer | undefined;
  if (!oldParent || !Number.isFinite(index)) return doc;
  const oldIndex = oldParent.children.findIndex((child) => child.id === nodeId);
  const boundary = Math.max(0, Math.min(Math.trunc(index), target.children.length));
  const insertAt = oldParent.id === parentId && oldIndex < boundary ? boundary - 1 : boundary;
  if (oldParent.id === parentId && oldIndex === insertAt) return doc;
  const weight = oldParent.weights?.[oldIndex] ?? 1;
  let layout = updateVisualNode(doc.layout, oldParent.id, (node) => {
    const parent = node as VisualContainer;
    return { ...parent, children: parent.children.filter((child) => child.id !== nodeId), ...(parent.weights ? { weights: parent.weights.filter((_, i) => i !== oldIndex) } : {}) };
  });
  layout = updateVisualNode(layout, parentId, (node) => {
    const parent = node as VisualContainer;
    const children = [...parent.children];
    children.splice(insertAt, 0, moving);
    const weights = [...(parent.weights ?? parent.children.map(() => 1))];
    weights.splice(insertAt, 0, weight);
    return { ...parent, children, ...(parent.weights ? { weights } : {}) };
  });
  return { ...doc, layout };
}

export function reorderVisualBlock(doc: VisualPageDocument, blockId: string, number: number): VisualPageDocument {
  const leaves = visualUnits(doc);
  const moving = compositeForBlock(doc, blockId) ?? leaves.find((node) => node.type === "block" && node.blockId === blockId);
  if (!moving || !Number.isFinite(number)) return doc;
  const from = leaves.indexOf(moving);
  const to = Math.max(0, Math.min(leaves.length - 1, Math.trunc(number) - 1));
  if (from === to) return doc;
  const anchor = leaves[to]!;
  const parent = flattenVisualLayout(doc.layout).find((node) => node.type !== "block" && node.children.some((child) => child.id === anchor.id)) as VisualContainer;
  return moveVisualNode(doc, moving.id, parent.id, parent.children.findIndex((child) => child.id === anchor.id) + (from < to ? 1 : 0));
}

export function ungroupVisualNode(doc: VisualPageDocument, id: string): VisualPageDocument {
  const nodes = flattenVisualLayout(doc.layout);
  const node = nodes.find((item) => item.id === id);
  const parent = nodes.find((item): item is VisualContainer => item.type !== "block" && item.children.some((child) => child.id === id));
  if (node && node.type !== "block" && node.content && node === doc.layout) {
    const { content: _content, ...layout } = node;
    return { ...doc, layout: { ...layout, type: "column" } };
  }
  if (!node || node.type === "block" || !parent) return doc;
  const index = parent.children.findIndex((child) => child.id === id);
  const origins = node.content?.origins;
  // Historical indices are usable only while the composite remains at its original boundary.
  // Moves, changed boundaries and removed/preset parents separate in the current location.
  if (node.content && validCompositeContent(node.content) && origins?.length && compositeOriginsMatch(node)
    && parent.id === origins[0]!.parentId && index === origins[0]!.index
    && origins.every((origin) => nodes.some((item) => item.id === origin.parentId && item.type !== "block" && !item.content))) {
    let layout = updateVisualNode(doc.layout, parent.id, (item) => {
      const container = item as VisualContainer;
      return { ...container, children: container.children.filter((child) => child.id !== id),
        ...(container.weights ? { weights: container.weights.filter((_, position) => position !== index) } : {}) };
    });
    for (const parentId of new Set(origins.map((origin) => origin.parentId))) {
      layout = updateVisualNode(layout, parentId, (item) => {
        const container = item as VisualContainer;
        const children = [...container.children];
        const entries = origins.map((origin, position) => ({ ...origin, leaf: node.children[position]! })).filter((origin) => origin.parentId === parentId).sort((a, b) => a.index - b.index);
        const weights = container.weights || entries.some((origin) => origin.weight !== undefined) ? [...(container.weights ?? container.children.map(() => 1))] : null;
        for (const origin of entries) {
          children.splice(origin.index, 0, origin.leaf);
          weights?.splice(origin.index, 0, origin.weight ?? 1);
        }
        return { ...container, children, ...(weights ? { weights } : {}) };
      });
    }
    return { ...doc, layout };
  }
  return { ...doc, layout: updateVisualNode(doc.layout, parent.id, (item) => {
    const container = item as VisualContainer;
    const children = [...container.children];
    children.splice(index, 1, ...node.children);
    const weights = container.weights ? [...container.weights] : null;
    if (weights) {
      const childWeights = node.children.map((_, position) => node.weights?.[position] ?? 1);
      const total = childWeights.reduce((sum, weight) => sum + weight, 0);
      weights.splice(index, 1, ...childWeights.map((weight) => weight / total * (container.weights?.[index] ?? 1)));
    }
    return { ...container, children, ...(weights ? { weights } : {}) };
  }) };
}

export function separateVisualContent(doc: VisualPageDocument, compositeId: string): VisualPageDocument {
  const node = flattenVisualLayout(doc.layout).find((item) => item.id === compositeId);
  return node && node.type !== "block" && node.content ? ungroupVisualNode(doc, compositeId) : doc;
}

export function applyVisualPreset(doc: VisualPageDocument, preset: VisualPreset): VisualPageDocument {
  const leaves = visualUnits(doc);
  const container = (type: "row" | "column", children: VisualLayoutNode[]): VisualContainer => ({ id: crypto.randomUUID(), type, children, gap: 12 });
  let layout: VisualLayoutNode;
  if (preset === "two-columns") {
    const half = Math.ceil(leaves.length / 2);
    layout = container("row", [container("column", leaves.slice(0, half)), container("column", leaves.slice(half))]);
  } else if (preset === "two-by-two") {
    const groups = Array.from({ length: 4 }, (_, index) => leaves.slice(Math.ceil(index * leaves.length / 4), Math.ceil((index + 1) * leaves.length / 4)));
    layout = container("column", [container("row", groups.slice(0, 2).map((group) => container("column", group))), container("row", groups.slice(2).map((group) => container("column", group)))]);
  } else {
    layout = container(preset === "rows" ? "row" : "column", leaves);
  }
  return { ...doc, layout };
}

export function createVisualBlock(kind: VisualBlock["kind"], geometry: PageElementGeometry | null = null): VisualBlock {
  return { id: crypto.randomUUID(), kind, text: kind === "heading" ? "Nuevo titulo" : kind === "image" ? "Descripcion de la imagen" : "Nuevo texto", role: kind === "heading" ? "heading" : kind === "image" ? "image" : "body", active: true, readAloud: true, includeInToc: kind === "heading", geometry,
    ...(kind === "heading" ? { headingLevel: 1 } : {}), ...(kind === "image" ? { imageWidth: 100, ...(geometry ? { source: "page-crop" } : {}) } : {}) };
}

export function appendVisualBlock(doc: VisualPageDocument, block: VisualBlock): VisualPageDocument {
  return normalizeVisualDocument({ ...doc, blocks: [...doc.blocks, block] });
}

export function clearVisualGeometry(doc: VisualPageDocument): VisualPageDocument {
  return { ...doc, blocks: doc.blocks.map((block) => ({ ...block, geometry: null })) };
}

export function pushVisualHistory(history: VisualHistory, doc: VisualPageDocument): VisualHistory {
  if (JSON.stringify(history.present) === JSON.stringify(doc)) return history;
  return { past: [...history.past.slice(-99), history.present], present: doc, future: [] };
}

export function undoVisualHistory(history: VisualHistory): VisualHistory {
  const previous = history.past.at(-1);
  return previous ? { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] } : history;
}

export function redoVisualHistory(history: VisualHistory): VisualHistory {
  const next = history.future[0];
  return next ? { past: [...history.past, history.present], present: next, future: history.future.slice(1) } : history;
}

export function safeVisualImageSource(source: string | undefined): boolean {
  if (!source) return false;
  if (/^lector-content-image:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source)) return true;
  if (/^data:image\/(avif|gif|jpeg|png|svg\+xml|webp);base64,[a-z0-9+/]+={0,2}$/i.test(source)) return source.slice(source.indexOf(",") + 1).length % 4 !== 1;
  if (!/^https?:\/\//i.test(source) || /[\s<>"\u0000-\u001f]/u.test(source)) return false;
  try { const url = new URL(source); return Boolean(url.hostname) && !url.username && !url.password; } catch { return false; }
}

export function visualDocumentSaveError(doc: VisualPageDocument, imageChanged = false): string | null {
  const nodes = flattenVisualLayout(doc.layout);
  if (doc.blocks.length > 500 || nodes.length > 1000) return "La pagina supera el limite de bloques o contenedores.";
  const depth = (node: VisualLayoutNode): number => node.type === "block" || !node.children.length ? 1 : 1 + Math.max(...node.children.map(depth));
  if (depth(doc.layout) > 8) return "La distribucion supera los 8 niveles. Simplifica los grupos antes de guardar.";
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  for (const node of nodes) {
    if (node.type === "block" || node.content === undefined) continue;
    if (!validCompositeContent(node.content) || !compositeOriginsMatch(node) || node.type !== "column" || node.children.length < 2
      || node.children.some((child) => child.type !== "block" || !blocks.has(child.blockId) || blocks.get(child.blockId)!.kind === "image")) return "El contenido compuesto debe ser una columna de al menos dos hojas de texto o titulo con metadatos validos.";
  }
  for (const block of doc.blocks) {
    if (block.active && block.kind !== "image" && !block.text.trim()) return "Completa el texto de los bloques activos antes de guardar.";
    if (block.kind !== "image") continue;
    if (block.source === "page-crop") {
      if (imageChanged) return "Hay un recorte de bloque pendiente. Guarda el documento antes de ajustar la imagen, restablece sus ajustes o cambia la fuente del bloque.";
      const box = block.geometry?.bbox;
      if (!box || ![box.left, box.top, box.width, box.height].every(Number.isFinite) || box.left < 0 || box.top < 0 || box.width <= 0 || box.height <= 0 || box.left + box.width > 1 || box.top + box.height > 1) return "Marca una zona valida para el recorte de imagen antes de guardar.";
    } else if (!safeVisualImageSource(block.source)) return "Completa la fuente de las imagenes con HTTPS, una referencia interna o una imagen de hasta 1 MB.";
  }
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderVisualBlockHtml(block: VisualBlock): string {
  if (block.kind === "image") {
    return safeVisualImageSource(block.source)
      ? `<figure><img src="${escapeHtml(block.source!)}" alt="${escapeHtml(block.text)}" />${block.text ? `<figcaption>${escapeHtml(block.text)}</figcaption>` : ""}</figure>`
      : `<p>${block.source === "page-crop" ? "Recorte de la pagina" : "Imagen sin fuente"}</p>`;
  }
  function inline(value: string) {
    const token = `VISUAL${crypto.randomUUID().replace(/-/g, "")}BREAK`;
    const escaped: string[] = [];
    const protectedText = value.replace(/\r\n?/g, "\n").replace(/\n/g, token).replace(/\\([\\*_\[\]()#])/g, (_, character: string) => {
      escaped.push(character);
      return `${token}ESC${escaped.length - 1}END`;
    });
    let html = escapeHtml(protectedText)
      .replace(/\[([^\]]+)\]\(reader-page-(\d+)-paragraph-(\d+)\)/g, '<a data-lector-page="$2" data-lector-paragraph="$3" href="?page=$2&amp;paragraph=$3">$1</a>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/_(.+?)_/g, "<em>$1</em>");
    escaped.forEach((character, index) => { html = html.split(`${token}ESC${index}END`).join(character); });
    return html.split(token).join("<br />");
  }
  const lines = block.text.trim().split("\n");
  const list = block.kind === "text" && lines.every((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line));
  if (list) {
    const tag = lines.every((line) => /^\s*\d+\./.test(line)) ? "ol" : "ul";
    return `<${tag}>${lines.map((line) => `<li>${inline(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))}</li>`).join("")}</${tag}>`;
  }
  const tag = block.kind === "heading" ? `h${Math.max(1, Math.min(6, block.headingLevel ?? 1))}` : "p";
  return `<${tag}>${inline(block.text)}</${tag}>`;
}

export function renderVisualPreviewHtml(doc: VisualPageDocument, includeInactive = false): string {
  const blocks = new Map(doc.blocks.map((block) => [block.id, block]));
  function render(node: VisualLayoutNode, alignment?: "center" | "right", slot?: number): string {
    const style = slot ? ` style="grid-column:${slot};grid-row:1;text-align:${alignment}${slot === 3 ? ";justify-self:end" : ""}"` : "";
    if (node.type === "block") {
      const block = blocks.get(node.blockId);
      return !block || (!includeInactive && !block.active) ? "" : `<section data-visual-block-id="${escapeHtml(block.id)}"${style}>${renderVisualBlockHtml(block)}</section>`;
    }
    if (node.content) return renderVisualCompositeHtml(node, doc.blocks, includeInactive);
    const autoFooter = isCenteredFooterRow(node, doc.blocks);
    return `<div data-visual-container="${node.type}"${autoFooter ? ' data-page-footer-row="true" style="display:grid;grid-template-columns:1fr auto 1fr;--reader-row-columns:1fr auto 1fr"' : style}>${node.children.map((child, index) => render(child, autoFooter ? index === 0 ? "center" : "right" : alignment, autoFooter ? index + 2 : undefined)).join("")}</div>`;
  }
  return render(doc.layout);
}

export function renderVisualCompositeHtml(container: VisualContainer, blocks: VisualBlock[], includeInactive = false): string {
  const content = container.content;
  if (!content || !validCompositeContent(content)) return "";
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const children = container.children.flatMap((child) => {
    const block = child.type === "block" ? byId.get(child.blockId) : undefined;
    return block && block.kind !== "image" && (includeInactive || block.active) ? [block] : [];
  });
  if (!children.length) return "";
  const style = [content.alignment ? `text-align:${content.alignment}` : "", content.fontScale ? `font-size:${content.fontScale}em` : ""].filter(Boolean).join(";");
  const attributes = `data-visual-composite-id="${escapeHtml(container.id)}"${style ? ` style="${style}"` : ""}`;
  const segments = children.map((block) => {
    const rendered = renderVisualBlockHtml(block);
    const listTag = rendered.match(/^<(ul|ol)>/)?.[1];
    const paragraph = content.kind === "text" && content.separator === "paragraph";
    const tag = paragraph ? listTag ?? "p" : "span";
    let html = rendered.replace(/^<(?:p|h[1-6]|ul|ol)>|<\/(?:p|h[1-6]|ul|ol)>$/g, "");
    // Inline composites keep list item text and formatting, not Markdown markers.
    if (listTag && !paragraph) html = html.replace(/<\/li><li>/g, "<br />").replace(/^<li>|<\/li>$/g, "");
    const segmentStyle = [content.alignment === undefined && block.alignment ? `text-align:${block.alignment}` : "",
      content.fontScale === undefined && block.fontScale !== undefined ? `font-size:${block.fontScale}em` : ""].filter(Boolean).join(";");
    return `<${tag} data-visual-block-id="${escapeHtml(block.id)}"${segmentStyle ? ` style="${escapeHtml(segmentStyle)}"` : ""}>${html}</${tag}>`;
  });
  if (content.kind === "heading") return `<h${content.headingLevel ?? 2} ${attributes}>${segments.join(content.separator === "space" ? " " : content.separator === "line" ? "<br />" : "<br /><br />")}</h${content.headingLevel ?? 2}>`;
  if (content.separator === "paragraph") return `<div ${attributes}>${segments.join("")}</div>`;
  return `<p ${attributes}>${segments.join(content.separator === "space" ? " " : "<br />")}</p>`;
}

// Only legacy/mocked responses use this path. SQL paragraphs are authoritative atoms, never lines.
function paragraphHtmlNode(html: Document | null, paragraph: BookPageResponse["page"]["paragraphs"][number]): Element | undefined {
  if (!html) return undefined;
  const nodes = Array.from(html.querySelectorAll("[data-paragraph-id], [data-paragraph-number], [data-visual-block-id]"));
  return nodes.find((element) => element.getAttribute("data-visual-block-id") === paragraph.paragraphId || element.getAttribute("data-paragraph-id") === paragraph.paragraphId)
    ?? nodes.find((element) => !element.hasAttribute("data-paragraph-id") && element.getAttribute("data-paragraph-number") === String(paragraph.paragraphNumber));
}

export function visualDocumentFromPage(page: BookPageResponse["page"]): VisualPageDocument {
  if (page.visualDocument) return page.visualDocument;
  const html = typeof DOMParser === "undefined" ? null : new DOMParser().parseFromString(page.htmlContent ?? "", "text/html");
  const blocks = [...page.paragraphs].sort((a, b) => a.paragraphNumber - b.paragraphNumber).map((paragraph): VisualBlock => {
    const node = paragraphHtmlNode(html, paragraph);
    const image = node?.matches("img,image") ? node : node?.querySelector("img, image");
    const heading = node?.matches("h1,h2,h3,h4,h5,h6") ? node : node?.querySelector("h1,h2,h3,h4,h5,h6");
    const markdownImage = paragraph.paragraphText.match(/^!\[([\s\S]*?)\]\(([\s\S]+)\)$/);
    const kind = image || markdownImage || paragraph.role === "image" ? "image" : heading || paragraph.role === "heading" || /^#{1,6}\s/.test(paragraph.paragraphText) ? "heading" : "text";
    const source = image?.getAttribute("src") ?? image?.getAttribute("href") ?? markdownImage?.[2];
    const text = kind === "image" ? image?.getAttribute("alt") ?? markdownImage?.[1] ?? paragraph.paragraphText : (node ? buildEditableTextFromHtmlContent(`<div>${node.outerHTML}</div>`) : null) ?? paragraph.paragraphText;
    const level = heading ? Number(heading.tagName.slice(1)) : paragraph.paragraphText.match(/^(#{1,6})\s/)?.[1]?.length ?? 1;
    return { id: paragraph.paragraphId, kind, text: kind === "heading" ? text.replace(/^#{1,6}\s+/, "") : text, role: paragraph.role ?? (kind === "heading" ? "heading" : kind === "image" ? "image" : "body"), active: paragraph.active ?? true, readAloud: paragraph.readAloud ?? true, includeInToc: paragraph.includeInToc ?? kind === "heading", geometry: paragraph.geometry ?? null,
      ...(source ? { source } : {}), ...(kind === "heading" ? { headingLevel: level } : {}), ...(kind === "image" ? { imageWidth: paragraph.imageWidth ?? 100 } : {}) };
  });
  return { version: 1, blocks, layout: { id: crypto.randomUUID(), type: "column", gap: 12, children: blocks.map((block) => ({ id: crypto.randomUUID(), type: "block", blockId: block.id })) } };
}

export function importedVisualSourceHtml(page: BookPageResponse["page"], doc: VisualPageDocument): string {
  const fallback = () => renderVisualPreviewHtml(doc, true).replace(/data-visual-block-id=/g, 'tabindex="0" role="button" data-paragraph-id=');
  const source = page.sourceHtmlContent ?? page.htmlContent;
  if (!source || typeof DOMParser === "undefined") return fallback();
  const html = new DOMParser().parseFromString(source, "text/html");
  html.querySelectorAll("script,iframe,object,embed,style,link,form").forEach((node) => node.remove());
  html.querySelectorAll("*").forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      if (/^on/i.test(attr.name) || ["srcdoc", "style"].includes(attr.name)) node.removeAttribute(attr.name);
      if (["href", "xlink:href"].includes(attr.name) && !attr.value.startsWith("#") && !safeVisualImageSource(attr.value)) node.removeAttribute(attr.name);
      if (attr.name === "src" && !safeVisualImageSource(attr.value)) node.removeAttribute("src");
    }
  });
  for (const paragraph of page.paragraphs) {
    const node = paragraphHtmlNode(html, paragraph);
    if (node) {
      node.setAttribute("data-paragraph-id", paragraph.paragraphId);
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
    }
  }
  if (!html.querySelector("[data-paragraph-id],[data-visual-block-id]")) return fallback();
  return html.body.innerHTML;
}

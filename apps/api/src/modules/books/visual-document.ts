import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import type { AnyNode } from "domhandler";
import sharp from "sharp";
import { z } from "zod";
import { geometrySchema, pageElementRoles, type ParagraphElementMetadata } from "./page-elements.js";
import { buildRichPageFromParagraphs, normalizeWhitespace } from "./rich-content.js";
import { pageStyleSchema, parsePageStyle, renderPageStyle, type PageStyle } from "./page-style.js";

const uuid = z.string().uuid().transform((id) => id.toLowerCase());
export function isSafeVisualImageSource(source: string): boolean {
  if (/^lector-content-image:[0-9a-f-]{36}$/iu.test(source)) return z.string().uuid().safeParse(source.slice(21)).success;
  if (/^data:image\/(?:avif|gif|jpeg|png|svg\+xml|webp);base64,[a-z0-9+/]+={0,2}$/iu.test(source)) {
    return source.slice(source.indexOf(",") + 1).length % 4 !== 1;
  }
  if (!/^https?:\/\//iu.test(source) || /[\s<>"\u0000-\u001f]/u.test(source)) return false;
  try { const url = new URL(source); return !!url.hostname && !url.username && !url.password; } catch { return false; }
}

export const visualBlockSchema = z.object({
  id: uuid, kind: z.enum(["text", "heading", "image"]), text: z.string().max(50000),
  style: pageStyleSchema.optional(), altText: z.string().max(50000).optional(),
  role: z.enum(pageElementRoles), active: z.boolean(), readAloud: z.boolean(), includeInToc: z.boolean(),
  source: z.string().max(48 * 1024 * 1024).transform((source) => /^lector-content-image:/iu.test(source)
    ? `lector-content-image:${source.slice(21).toLowerCase()}` : source).optional(),
  sourceKey: z.string().regex(/^image:\d{1,5}$/u).optional(),
  headingLevel: z.number().int().min(1).max(6).optional(), imageWidth: z.number().finite().min(1).max(100).optional(),
  fontScale: z.number().finite().min(0.5).max(3).optional(), alignment: z.enum(["left", "center", "right"]).optional(),
  geometry: geometrySchema.nullable().optional()
}).strict().superRefine((block, ctx) => {
  if (block.kind !== "image" && block.active && !block.text.trim()) ctx.addIssue({ code: "custom", path: ["text"], message: "Un bloque activo debe contener texto." });
  if (block.source !== undefined && block.kind !== "image") ctx.addIssue({ code: "custom", path: ["source"], message: "Solo las imagenes admiten source." });
  if (block.altText !== undefined && block.kind !== "image") ctx.addIssue({ code: "custom", path: ["altText"], message: "Solo las imagenes admiten altText." });
  if (block.kind === "image" && (!block.source || (block.source !== "page-crop" && !isSafeVisualImageSource(block.source)))) {
    ctx.addIssue({ code: "custom", path: ["source"], message: "Origen de imagen no permitido." });
  }
  if (block.source === "page-crop" && !block.geometry) ctx.addIssue({ code: "custom", path: ["geometry"], message: "El recorte requiere geometria." });
});
export type VisualBlock = z.infer<typeof visualBlockSchema>;
const visualContentSchema = z.object({
  kind: z.enum(["text", "heading"]), separator: z.enum(["space", "line", "paragraph"]), includeInToc: z.boolean(),
  headingLevel: z.number().int().min(1).max(6).optional(), alignment: z.enum(["left", "center", "right"]).optional(),
  fontScale: z.number().finite().min(0.5).max(3).optional(),
  origins: z.array(z.object({ leafId: uuid, parentId: uuid, index: z.number().int().min(0).max(1000),
    weight: z.number().finite().positive().optional() }).strict()).max(500).optional()
}).strict();
export type VisualContent = z.infer<typeof visualContentSchema>;
export type VisualLayoutNode = { id: string; type: "block"; blockId: string }
  | { id: string; type: "row" | "column"; children: VisualLayoutNode[]; weights?: number[] | undefined; gap?: number | undefined; content?: VisualContent | undefined;
    style?: PageStyle | undefined; semantic?: "table" | "tableRow" | "tableCell" | "figure" | undefined };
export type VisualPageDocument = { version: 1; blocks: VisualBlock[]; layout: VisualLayoutNode };

const nodeSchema: z.ZodType<VisualLayoutNode> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ id: uuid, type: z.literal("block"), blockId: uuid }).strict(),
  z.object({ id: uuid, type: z.enum(["row", "column"]), children: z.array(nodeSchema).max(1000),
    weights: z.array(z.number().finite().positive()).max(1000).optional(), gap: z.number().finite().min(0).max(48).optional(),
    content: visualContentSchema.optional(), style: pageStyleSchema.optional(),
    semantic: z.enum(["table", "tableRow", "tableCell", "figure"]).optional() }).strict()
]));

// Check cycles and budgets before invoking the recursive schema (also used by in-process adapters).
export const visualPageDocumentSchema = z.unknown().superRefine((value, ctx) => {
  const stack = [{ node: (value as { layout?: unknown } | null)?.layout, depth: 1 }];
  const seen = new Set<object>();
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (!node || typeof node !== "object") continue;
    if (seen.has(node) || ++count > 1000 || depth > 8) {
      ctx.addIssue({ code: "custom", path: ["layout"], message: "Arbol ciclico, compartido o fuera de los limites (1000 nodos, profundidad 8)." });
      return;
    }
    seen.add(node);
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) {
      if (children.length > 1000) { ctx.addIssue({ code: "custom", path: ["layout"], message: "Demasiados nodos." }); return; }
      for (const child of children) stack.push({ node: child, depth: depth + 1 });
    }
  }
}).pipe(z.object({ version: z.literal(1), blocks: z.array(visualBlockSchema).max(500), layout: nodeSchema }).strict()
  .superRefine((document, ctx) => {
    const ids = new Set<string>();
    const blockIds = new Set<string>();
    const references = new Set<string>();
    const sourceKeys = new Set<string>();
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const block of document.blocks) {
      if (ids.has(block.id)) issue("ID de bloque duplicado.");
      ids.add(block.id); blockIds.add(block.id);
      if (block.sourceKey) {
        if (sourceKeys.has(block.sourceKey)) issue("Referencia de origen duplicada.");
        sourceKeys.add(block.sourceKey);
      }
    }
    const visit = (node: VisualLayoutNode, parentSemantic?: "table" | "tableRow" | "tableCell" | "figure") => {
      if (ids.has(node.id)) issue("Los IDs de bloques y nodos deben ser unicos.");
      ids.add(node.id);
      if (node.type === "block") {
        if (!blockIds.has(node.blockId) || references.has(node.blockId)) issue("Referencia inexistente o duplicada.");
        references.add(node.blockId);
      } else {
        if (node.semantic && node.type !== (node.semantic === "tableRow" ? "row" : "column")) {
          issue("semantic requiere tableRow row y table/tableCell/figure column.");
        }
        if (node.semantic === "table" && node.children.some((child) => child.type !== "row" || child.semantic !== "tableRow")) {
          issue("table solo admite hijos tableRow.");
        }
        if (node.semantic === "tableRow" && (parentSemantic !== "table"
          || node.children.some((child) => child.type !== "column" || child.semantic !== "tableCell"))) {
          issue("tableRow requiere padre table e hijos tableCell.");
        }
        if (node.semantic === "tableCell" && parentSemantic !== "tableRow") {
          issue("tableCell requiere padre tableRow.");
        }
        if (node.content && (node.type !== "column" || node.children.length < 2 || node.children.some((child) =>
          child.type !== "block" || document.blocks.find((block) => block.id === child.blockId)?.kind === "image"))) {
          issue("content requiere una columna con al menos dos bloques directos de texto, sin imagenes ni contenedores.");
        }
        if (node.content?.origins) {
          const leafIds = new Set(node.children.map((child) => child.id));
          const origins = node.content.origins;
          if (origins.length !== node.children.length || new Set(origins.map((origin) => origin.leafId)).size !== origins.length
            || origins.some((origin) => !leafIds.has(origin.leafId) || origin.parentId === node.id || leafIds.has(origin.parentId))) {
            issue("origins requiere un origen por hijo directo y padres historicos distintos del compuesto y de sus hojas.");
          }
        }
        if (node.weights && node.weights.length !== node.children.length) issue("weights debe corresponder a children.");
        node.children.forEach((child) => visit(child, node.semantic));
      }
    };
    visit(document.layout);
    if (references.size !== blockIds.size) issue("Cada bloque debe aparecer exactamente una vez en el arbol.");
    if (!document.blocks.length && document.layout.type === "block") issue("El documento vacio requiere un contenedor raiz.");
  }));
export const visualDocumentSchema = visualPageDocumentSchema;

export function orderedVisualBlocks(document: VisualPageDocument): VisualBlock[] {
  const byId = new Map(document.blocks.map((block) => [block.id, block]));
  const ordered: VisualBlock[] = [];
  const visit = (node: VisualLayoutNode) => {
    if (node.type === "block") ordered.push(byId.get(node.blockId)!);
    else node.children.forEach(visit);
  };
  visit(document.layout);
  return ordered;
}

export function isCenteredFooterRow(node: VisualLayoutNode, blocks: readonly VisualBlock[]): boolean {
  if (node.type !== "row" || node.semantic !== undefined || node.content !== undefined || node.weights !== undefined || node.children.length !== 2) return false;
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

export function renderVisualDocument(input: VisualPageDocument, options: { includeInactive?: boolean; languageCode?: "es" | "it" } = {}) {
  const document = visualPageDocumentSchema.parse(input);
  const atoms = new Map<string, string>();
  const paragraphs: string[] = [];
  const paragraphIds: string[] = [];
  const paragraphMetadata: ParagraphElementMetadata[] = [];
  const visibleText: string[] = [];
  const editedAtoms: string[] = [];
  for (const [index, block] of orderedVisualBlocks(document).entries()) {
    const token = `VISUAL${randomUUID().replace(/-/gu, "")}BREAK`;
    const text = block.text.replace(/\r\n?/gu, "\n");
    const listLines = text.trim().split("\n");
    const isList = block.kind === "text" && listLines.length > 0 && listLines.every((line) => /^\s*(?:[-*]|\d+\.)\s+/u.test(line));
    const formattedText = isList ? text.replace(/^\s*\*\s+/gmu, "- ") : text;
    const escapedCharacters: Array<{ token: string; character: string }> = [];
    const inlineText = formattedText.replace(/\n/gu, token).replace(/\\([\\*_\[\]()#])/gu, (_, character: string) => {
      const escaped = { token: `${token}ESC${escapedCharacters.length}END`, character };
      escapedCharacters.push(escaped);
      return escaped.token;
    });
    let formatted = block.kind === "image" ? `![](${block.source === "page-crop" ? "https://page-crop.invalid/" : block.source})`
      : block.kind === "heading" ? `${"#".repeat(block.headingLevel ?? 2)} ${inlineText}` : inlineText;
    const prefix = `VISUAL${randomUUID().replace(/-/gu, "")}TEXT`;
    const protect = block.kind === "text" && /^(?:#{1,6}\s|!\[|:::block|::(?:left|center|right)::)/u.test(formatted);
    if (protect) formatted = prefix + formatted;
    const empty = !formatted.trim();
    const rich = buildRichPageFromParagraphs([empty ? prefix : formatted], { inferHeadings: false,
      ...(options.languageCode ? { languageCode: options.languageCode } : {}) });
    const html = load(rich.htmlContent ?? "<p class=\"reader-rich-node\"></p>", {}, false);
    const atom = html(".reader-rich-node").first();
    if (block.kind === "heading" && atom[0]?.type === "tag") atom[0].name = `h${block.headingLevel ?? 2}`;
    let inner = atom.html() ?? "";
    for (const escaped of escapedCharacters) inner = inner.split(escaped.token).join(escaped.character);
    inner = inner.split(token).join("<br>");
    if (protect || empty) inner = inner.split(prefix).join("");
    if (isList && atom[0]?.type === "tag") {
      atom[0].name = listLines.every((line) => /^\s*\d+\.\s+/u.test(line)) ? "ol" : "ul";
      const items = inner.split("<br>").map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/u, ""));
      inner = items.map((line, itemIndex) => `<li>${line}${itemIndex < items.length - 1 ? '<br style="display:none" aria-hidden="true">' : ""}</li>`).join("");
    }
    atom.html(inner).attr("data-paragraph-number", String(index + 1)).attr("data-visual-block-id", block.id)
      .attr("data-element-role", block.role).attr("data-read-aloud", String(block.readAloud)).attr("data-active", String(block.active));
    if (block.kind === "image" && block.source) atom.find("img").attr("src", block.source);
    if (block.kind === "heading") atom.attr("data-include-in-toc", String(block.includeInToc));
    if (block.geometry) atom.attr("data-element-geometry", JSON.stringify(block.geometry));
    const fontScale = block.fontScale ?? block.style?.fontScale;
    const alignment = block.alignment ?? block.style?.alignment;
    const editorialStyle = renderPageStyle({ ...block.style, fontScale, alignment });
    const styles: string[] = editorialStyle ? [editorialStyle] : [];
    if (block.imageWidth !== undefined) {
      atom.attr("data-image-width", String(block.imageWidth));
      styles.push(`--reader-image-width:${block.imageWidth}%`, `--visual-image-width:${block.imageWidth}%`);
    }
    if (fontScale !== undefined) atom.attr("data-font-scale", String(fontScale));
    if (alignment) atom.attr("data-text-align", alignment);
    if (block.kind === "image") atom.find("img").attr("style", "width:var(--reader-image-width,var(--visual-image-width,auto));max-width:100%;height:auto");
    if (styles.length) atom.attr("style", styles.join(";") + ";");
    let plain = rich.paragraphs[0] ?? "";
    for (const escaped of escapedCharacters) plain = plain.split(escaped.token).join(escaped.character);
    plain = plain.split(token).join("\n");
    if (protect || empty) plain = plain.split(prefix).join("");
    if (isList) {
      plain = plain.replace(/^\s*(?:[-*]|\d+\.)\s+/gmu, "");
      atom.attr("data-reader-text", plain);
    }
    if (block.kind === "image") {
      const altText = block.altText ?? text;
      const narration = block.altText === undefined ? text.trim() : [altText.trim(), text.trim()].filter(Boolean).join(" ");
      plain = `${options.languageCode === "it" ? "Immagine." : "Imagen."}${narration ? ` ${narration}` : ""}`;
      atom.attr("data-reader-text", plain).find("img").attr("alt", altText);
      if (block.altText !== undefined) atom.attr("data-image-alt-separated", "true");
      if (text) {
        const caption = html("<figcaption></figcaption>").text(text);
        caption.html((caption.html() ?? "").replace(/\n/gu, "<br>"));
        atom.append(caption);
      }
    }
    if (block.active && block.kind !== "image" && !plain.trim()) throw Object.assign(new Error("Un bloque activo debe contener texto legible."), { statusCode: 400 });
    paragraphs.push(plain); paragraphIds.push(block.id);
    paragraphMetadata.push({ role: block.role, readAloud: block.readAloud, active: block.active, includeInToc: block.includeInToc,
      imageWidth: block.imageWidth ?? null, geometry: block.geometry ?? null });
    if (options.includeInactive || block.active) {
      let editable = formatted;
      for (const escaped of escapedCharacters) editable = editable.split(escaped.token).join(`\\${escaped.character}`);
      atoms.set(block.id, html.html(atom)); visibleText.push(plain); editedAtoms.push(editable.split(token).join("\n").split(prefix).join(""));
    }
  }
  const render = (node: VisualLayoutNode): string => {
    if (node.type === "block") {
      const atom = atoms.get(node.blockId);
      return atom ? `<section class="reader-reading-block" data-layout-id="${node.id}" data-reading-block-id="${node.blockId}">${atom}</section>` : "";
    }
    const semanticAttributes = node.semantic ? ` data-layout-semantic="${node.semantic}" role="${{ table: "table", tableRow: "row", tableCell: "cell", figure: "group" }[node.semantic]}"` : "";
    const containerStyle = renderPageStyle({ ...node.style,
      ...(node.content?.fontScale !== undefined ? { fontScale: undefined } : {}),
      ...(node.content?.alignment !== undefined ? { alignment: undefined } : {}) });
    if (node.content) {
      const content = node.content;
      const members = node.children.flatMap((child) => child.type === "block" && atoms.has(child.blockId) ? [child.blockId] : []);
      if (!members.length) return "";
      const html = load("<section class=\"reader-content-compound\"></section>", {}, false);
      const section = html("section").attr("data-composite-id", node.id).attr("data-layout-id", node.id);
      if (containerStyle) section.attr("style", containerStyle + ";");
      if (node.style?.alignment) section.attr("data-text-align", node.style.alignment);
      if (node.semantic) section.attr("data-layout-semantic", node.semantic).attr("role", { table: "table", tableRow: "row", tableCell: "cell", figure: "group" }[node.semantic]);
      const heading = content.kind === "heading";
      const wrapper = html(`<${heading ? `h${content.headingLevel ?? 2}` : content.separator === "paragraph" ? "div" : "p"}></${heading ? `h${content.headingLevel ?? 2}` : content.separator === "paragraph" ? "div" : "p"}>`);
      if (heading) {
        const anchor = members.find((id) => document.blocks.find((block) => block.id === id)?.active) ?? members[0]!;
        wrapper.attr("data-composite-anchor-number", String(paragraphIds.indexOf(anchor) + 1))
          .attr("data-composite-anchor-id", anchor).attr("data-composite-include-in-toc", String(content.includeInToc))
          .attr("data-composite-title", normalizeWhitespace(members.map((id) => paragraphs[paragraphIds.indexOf(id)]).join(" ")));
      }
      const styles: string[] = [];
      if (content.alignment) { wrapper.attr("data-text-align", content.alignment); styles.push(`text-align:${content.alignment}`); }
      if (content.fontScale !== undefined) { wrapper.attr("data-font-scale", String(content.fontScale)); styles.push(`--reader-font-scale:${content.fontScale}`, `font-size:${content.fontScale}em`); }
      if (styles.length) wrapper.attr("style", styles.join(";") + ";");
      members.forEach((id, index) => {
        const atom = load(atoms.get(id)!, {}, false)(".reader-rich-node").first();
        const tag = heading || content.separator !== "paragraph" ? "span" : "p";
        if (atom[0]?.type === "tag") {
          const list = ["ul", "ol"].includes(atom[0].name);
          if (list && (heading || content.separator !== "paragraph")) {
            const items = atom.find("li").toArray().map((item) => {
              const html = load(item, {}, false);
              html("br[aria-hidden]").remove();
              return html("li").html() ?? "";
            });
            atom.html(items.join("<br>"));
          }
          if (!list || heading || content.separator !== "paragraph") atom[0].name = tag;
        }
        atom.attr("data-reader-text", paragraphs[paragraphIds.indexOf(id)]!);
        if (content.fontScale !== undefined) {
          atom.removeAttr("data-font-scale").attr("style", (atom.attr("style") ?? "").replace(/(?:--reader-font-scale|font-size):[^;]+;?/gu, ""));
        }
        if (content.alignment) atom.removeAttr("data-text-align").attr("style", (atom.attr("style") ?? "").replace(/text-align:[^;]+;?/gu, ""));
        if (index && (heading || content.separator !== "paragraph")) wrapper.append(content.separator === "line" ? "<br>\n" : content.separator === "paragraph" ? "<br><br>\n" : " ");
        wrapper.append(atom);
      });
      section.append(wrapper);
      return html.html();
    }
    const autoFooter = isCenteredFooterRow(node, document.blocks);
    const children = node.children.map((child, index) => {
      let rendered = render(child);
      if (autoFooter && rendered) {
        const html = load(rendered, {}, false);
        const alignment = index === 0 ? "center" : "right";
        const root = html.root().children().first();
        root.attr("style", `${root.attr("style") ?? ""};grid-column:${index + 2};grid-row:1;${index === 1 ? "justify-self:end;" : ""}`);
        html(".reader-rich-node").each((_, atom) => {
          const element = html(atom);
          element.attr("data-text-align", alignment).attr("style", `${(element.attr("style") ?? "").replace(/text-align:[^;]+;?/gu, "")};text-align:${alignment};`);
        });
        rendered = html.html();
      }
      return { html: rendered, weight: node.weights?.[index] ?? 1 };
    }).filter((child) => child.html);
    if (!children.length) return "";
    const weights = children.map((child) => `minmax(0,${child.weight}fr)`).join(" ");
    return `<div class="reader-reading-${node.type}" data-layout-id="${node.id}"${semanticAttributes}${node.style?.alignment ? ` data-text-align="${node.style.alignment}"` : ""}${autoFooter ? ' data-page-footer-row="true"' : ""} style="${containerStyle ? containerStyle + ";" : ""}--reader-layout-gap:${node.gap ?? 12}px;--reader-layout-weights:${weights};gap:${node.gap ?? 12}px;${node.type === "row" ? `--reader-row-columns:${autoFooter ? "1fr auto 1fr" : weights};` : "display:grid;grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;align-content:start;"}">${children.map((child) => child.html).join("")}</div>`;
  };
  return { htmlContent: `<div class="epub-page-shell"><div class="epub-page-body ocr-page-body">${render(document.layout)}</div></div>`,
    paragraphs, paragraphIds, paragraphMetadata, rawText: visibleText.join("\n"), editedText: editedAtoms.join("\n") };
}

export type VisualStoredParagraph = ParagraphElementMetadata & { paragraphId: string; paragraphNumber: number; paragraphText: string };

function sourceOfImage(html: ReturnType<typeof load>, node: AnyNode): string | undefined {
  const image = html(node);
  if (image.is("svg")) {
    const vector = image.clone().attr("xmlns", image.attr("xmlns") ?? "http://www.w3.org/2000/svg");
    return `data:image/svg+xml;base64,${Buffer.from(html.html(vector)).toString("base64")}`;
  }
  return image.attr("data-original-src") ?? image.attr("data-lector-source") ?? image.attr("src") ?? image.attr("href") ?? image.attr("xlink:href");
}

export function visualSourceHtml(source: string | null, paragraphs: readonly VisualStoredParagraph[], document: VisualPageDocument): string | null {
  if (!source) return source;
  const html = load(source, {}, false);
  const imageSources = new Map(html("img,image,svg").toArray().map((node) => [node, sourceOfImage(html, node)]));
  const ids = new Set(document.blocks.map((block) => block.id));
  html("[data-paragraph-number]").each((_, node) => {
    const element = html(node);
    const id = element.attr("data-paragraph-id") ?? element.attr("data-visual-block-id")
      ?? paragraphs.find((paragraph) => paragraph.paragraphNumber === Number(element.attr("data-paragraph-number")))?.paragraphId;
    if (id && ids.has(id)) element.attr("data-paragraph-id", id);
  });
  const used = new Set<string>();
  let imageIndex = 0;
  html("img,image,svg").each((_, node) => {
    const element = html(node);
    if (element.parents("svg").length) return;
    const sourceKey = `image:${imageIndex++}`;
    const source = imageSources.get(node);
    const parentId = element.closest("[data-paragraph-id]").attr("data-paragraph-id");
    const parent = document.blocks.find((block) => block.id === parentId && block.kind === "image");
    const block = document.blocks.find((block) => block.id === element.attr("data-visual-block-id"))
      ?? document.blocks.find((block) => block.sourceKey === sourceKey)
      ?? parent ?? document.blocks.find((block) => block.kind === "image" && block.source === source && !used.has(block.id));
    if (block) { element.attr("data-visual-block-id", block.id); used.add(block.id); }
  });
  return html.html();
}

export function buildVisualDocumentFromPage(
  page: string | null | { htmlContent?: string | null; paragraphs?: readonly VisualStoredParagraph[] },
  storedParagraphs: readonly VisualStoredParagraph[] = typeof page === "object" && page ? page.paragraphs ?? [] : []
): VisualPageDocument {
  const html = load((typeof page === "string" ? page : page?.htmlContent) ?? "", {}, false);
  const numbered = html("[data-paragraph-number]");
  const aligned = numbered.length === storedParagraphs.length
    && new Set(numbered.toArray().map((node) => Number(html(node).attr("data-paragraph-number")))).size === numbered.length;
  const blocks: VisualBlock[] = [];
  const leaves = new Map<number, VisualLayoutNode>();
  const includedImages = new Set<AnyNode>();
  const extraLeaves = new Map<AnyNode, VisualLayoutNode>();
  const sourceKeys = new Map(html("img,image,svg").toArray().filter((node) => !html(node).parents("svg").length)
    .map((node, index) => [node, `image:${index}`]));
  const inline = (node: AnyNode): string => {
    if (node.type === "text") return node.data.replace(/([\\*_\[\]()#])/gu, "\\$1");
    if (node.type !== "tag") return "";
    if (node.name === "br") return "\n";
    const content = node.children.map(inline).join("");
    if (node.name === "strong" || node.name === "b") return `**${content}**`;
    if (node.name === "em" || node.name === "i") return `*${content}*`;
    if (node.name === "a" && node.attribs["data-lector-page"] && node.attribs["data-lector-paragraph"]) return `[${content}](reader-page-${node.attribs["data-lector-page"]}-paragraph-${node.attribs["data-lector-paragraph"]})`;
    return content;
  };
  for (const paragraph of [...storedParagraphs].sort((a, b) => a.paragraphNumber - b.paragraphNumber)) {
    const element = numbered.filter((_, node) => Number(html(node).attr("data-paragraph-number")) === paragraph.paragraphNumber).first();
    const tag = element[0]?.type === "tag" ? element[0].name : "";
    const headingLevel = /^h[1-6]$/u.test(tag) ? Number(tag.slice(1)) : undefined;
    const image = element.is("img,image,svg") ? element : element.find("img, image, svg").first();
    const source = image[0] ? sourceOfImage(html, image[0]) : undefined;
    const markdown = element.contents().toArray().map(inline).join("").trim();
    const alt = image.attr("alt") ?? element.find("figcaption").text();
    const plain = element.attr("data-reader-text") ?? element.clone().find("br").replaceWith("\n").end().text();
    const matches = normalizeWhitespace(plain) === normalizeWhitespace(paragraph.paragraphText)
      || (!!image.length && ["Imagen.", "Immagine."].some((label) => normalizeWhitespace(`${label} ${alt}`) === normalizeWhitespace(paragraph.paragraphText)));
    const residualText = element.clone().find("img,image,svg,figcaption,[style*='display: none'],[style*='display:none']").remove().end().text().trim();
    const imageOnly = element.is("img,image,svg") || element.is("figure") && !residualText;
    const isImage = imageOnly && !!image.length && !!source && isSafeVisualImageSource(source) && matches;
    if (isImage && image[0]) includedImages.add(image[0]);
    const kind = isImage ? "image" : headingLevel && matches ? "heading" : "text";
    const style = element.attr("style") ?? "";
    const pageStyle = parsePageStyle(style);
    const separatedAlt = isImage && element.attr("data-image-alt-separated") === "true";
    const alignment = element.attr("data-text-align") ?? style.match(/(?:^|;)\s*text-align\s*:\s*(left|center|right)\b/iu)?.[1]?.toLowerCase();
    const imageWidth = paragraph.imageWidth ?? Number(element.attr("data-image-width"));
    const fontScale = Number(element.attr("data-font-scale") ?? style.match(/(?:^|;)\s*font-size\s*:\s*([\d.]+)em\b/iu)?.[1]);
    const include = element.attr("data-include-in-toc");
    blocks.push({ id: paragraph.paragraphId, kind, text: isImage ? separatedAlt ? element.find("figcaption").clone().find("br").replaceWith("\n").end().text() : alt : matches ? markdown : paragraph.paragraphText.replace(/([\\*_\[\]()#])/gu, "\\$1"),
      ...(pageStyle ? { style: pageStyle } : {}), ...(separatedAlt ? { altText: alt } : {}),
      role: paragraph.role, active: paragraph.active !== false, readAloud: paragraph.readAloud,
      includeInToc: paragraph.includeInToc ?? (include !== undefined ? include === "true" : !!headingLevel && headingLevel <= 3),
      geometry: paragraph.geometry ?? null,
      ...(isImage ? { source, sourceKey: sourceKeys.get(image[0]!) } : {}), ...(kind === "heading" ? { headingLevel } : {}),
      ...(Number.isFinite(imageWidth) && imageWidth >= 1 && imageWidth <= 100 ? { imageWidth } : {}),
      ...(Number.isFinite(fontScale) && fontScale >= 0.5 && fontScale <= 3 ? { fontScale } : {}),
      ...(alignment === "left" || alignment === "center" || alignment === "right" ? { alignment } : {}) });
    leaves.set(paragraph.paragraphNumber, { id: randomUUID(), type: "block", blockId: paragraph.paragraphId });
  }
  html("img,image,svg").each((_, node) => {
    const image = html(node);
    if (includedImages.has(node) || image.parents("svg").length) return;
    const source = sourceOfImage(html, node);
    if (!source || !isSafeVisualImageSource(source)) return;
    const id = randomUUID();
    const text = image.attr("alt") ?? image.find("title").text();
    const style = parsePageStyle(image.attr("style") ?? image.closest("figure").attr("style") ?? "");
    blocks.push({ id, kind: "image", source, sourceKey: sourceKeys.get(node), text, role: "image", active: true, readAloud: false, includeInToc: false, geometry: null, ...(style ? { style } : {}) });
    extraLeaves.set(node, { id: randomUUID(), type: "block", blockId: id });
  });
  const used = new Set<number>();
  const widthFor = (node: VisualLayoutNode): number | null => {
    const references = new Set<string>();
    const collect = (child: VisualLayoutNode) => { if (child.type === "block") references.add(child.blockId); else child.children.forEach(collect); };
    collect(node);
    const boxes = blocks.filter((block) => references.has(block.id) && !["header", "footer", "pageNumber"].includes(block.role))
      .flatMap((block) => block.geometry ? [block.geometry.bbox] : []);
    const substantial = boxes.filter((box) => box.width >= 0.1);
    const relevant = substantial.length ? substantial : boxes;
    return relevant.length ? Math.max(...relevant.map((box) => box.left + box.width)) - Math.min(...relevant.map((box) => box.left)) : null;
  };
  const adapt = (node: AnyNode): VisualLayoutNode[] => {
    if (node.type !== "tag") return [];
    const extra = extraLeaves.get(node);
    if (extra) return [extra];
    const element = html(node);
    const number = Number(element.attr("data-paragraph-number"));
    if (leaves.has(number)) {
      if (used.has(number)) return [];
      used.add(number);
      const nestedImages = element.find("img,image,svg").toArray().flatMap((image) => extraLeaves.has(image) ? [extraLeaves.get(image)!] : []);
      return [leaves.get(number)!, ...nestedImages];
    }
    const children = node.children.flatMap(adapt);
    if (!children.length) return [];
    if (element.hasClass("reader-reading-row") || element.hasClass("reader-reading-column") || element.hasClass("reader-content-compound") || element.attr("data-reading-block-id")) {
      if (element.attr("data-reading-block-id") && z.string().uuid().safeParse(element.attr("data-layout-id")).success && children.length === 1) return children;
      const type = element.hasClass("reader-reading-row") ? "row" : "column";
      const knownWrapper = z.string().uuid().safeParse(element.attr("data-layout-id")).success;
      const style = knownWrapper ? parsePageStyle(element.attr("style") ?? "") : undefined;
      const semantic = knownWrapper ? element.attr("data-layout-semantic") : undefined;
      const weights = knownWrapper ? [...(element.attr("style") ?? "").matchAll(/minmax\(0,([\d.]+)fr\)/gu)].slice(0, children.length).map((match) => Number(match[1])) : [];
      const gap = knownWrapper ? Number((element.attr("style") ?? "").match(/--reader-layout-gap:([\d.]+)px/u)?.[1]) : NaN;
      const widths = type === "row" ? children.map(widthFor) : [];
      if (type === "column") {
        const width = widthFor({ id: randomUUID(), type, children });
        const setImageWidths = (child: VisualLayoutNode) => {
          if (child.type !== "block") return;
          const block = blocks.find((item) => item.id === child.blockId);
          if (width && block?.kind === "image" && block.geometry && block.imageWidth === undefined) {
            block.imageWidth = Math.max(1, Math.min(100, Math.round(block.geometry.bbox.width / width * 100)));
          }
        };
        children.forEach(setImageWidths);
      }
      return [{ id: knownWrapper ? element.attr("data-layout-id")! : randomUUID(), type, children,
        ...(style ? { style } : {}),
        ...(["table", "tableRow", "tableCell", "figure"].includes(semantic ?? "") && type === (semantic === "tableRow" ? "row" : "column") ? { semantic: semantic as "table" | "tableRow" | "tableCell" | "figure" } : {}),
        ...(Number.isFinite(gap) && gap >= 0 && gap <= 48 ? { gap } : {}),
        ...(weights.length === children.length && weights.every((weight) => weight > 0) ? { weights } : widths.length && widths.every((width) => width && width > 0) ? { weights: widths as number[] } : {}) }];
    }
    return children;
  };
  const children = aligned ? html.root().contents().toArray().flatMap(adapt) : [];
  for (const [number, leaf] of leaves) if (!used.has(number)) children.push(leaf);
  const present = new Set<string>();
  const collect = (node: VisualLayoutNode) => { if (node.type === "block") present.add(node.blockId); else node.children.forEach(collect); };
  children.forEach(collect);
  for (const leaf of extraLeaves.values()) if (leaf.type === "block" && !present.has(leaf.blockId)) children.push(leaf);
  const knownRoot = children.length === 1 && children[0]!.type !== "block"
    && html("[data-layout-id]").toArray().some((node) => html(node).attr("data-layout-id") === children[0]!.id);
  return { version: 1, blocks, layout: knownRoot ? children[0]! : { id: randomUUID(), type: "column", children } };
}

export async function cropVisualPageImage(buffer: Buffer, geometry: NonNullable<VisualBlock["geometry"]>, rotation = 0): Promise<Buffer> {
  const oriented = await sharp(buffer).rotate(rotation).toBuffer();
  const { width, height } = await sharp(oriented).metadata();
  if (!width || !height) throw Object.assign(new Error("La imagen original no tiene dimensiones validas."), { statusCode: 400 });
  const { bbox } = geometrySchema.parse(geometry);
  const left = Math.min(width - 1, Math.floor(bbox.left * width));
  const top = Math.min(height - 1, Math.floor(bbox.top * height));
  return sharp(oriented).extract({ left, top, width: Math.max(1, Math.min(width - left, Math.ceil(bbox.width * width))),
    height: Math.max(1, Math.min(height - top, Math.ceil(bbox.height * height))) }).png().toBuffer();
}

import { load } from "cheerio";
import { z } from "zod";

export const pageElementRoles = ["body", "heading", "image", "imageCaption", "header", "footer", "pageNumber"] as const;
export type PageElementRole = (typeof pageElementRoles)[number];
export type Geometry = { bbox: { left: number; top: number; width: number; height: number } };
export type ParagraphElementMetadata = {
  role: PageElementRole; readAloud: boolean; geometry?: Geometry | null | undefined;
  active?: boolean | undefined; includeInToc?: boolean | null | undefined; imageWidth?: number | null | undefined;
};

const tolerance = 0.000001;
export const geometrySchema = z.object({
  bbox: z.object({
    left: z.number().finite().min(-tolerance).max(1),
    top: z.number().finite().min(-tolerance).max(1),
    width: z.number().finite().positive().max(1 + tolerance),
    height: z.number().finite().positive().max(1 + tolerance)
  }).strict()
}).strict().refine(({ bbox }) => bbox.left + bbox.width <= 1 + tolerance && bbox.top + bbox.height <= 1 + tolerance,
  { message: "Geometry must fit within the normalized page." }).transform(({ bbox }): Geometry => {
  const left = Math.max(0, bbox.left);
  const top = Math.max(0, bbox.top);
  return { bbox: { left, top, width: Math.min(bbox.width, 1 - left), height: Math.min(bbox.height, 1 - top) } };
}).refine(({ bbox }) => bbox.width > 0 && bbox.height > 0);

export const paragraphElementMetadataSchema = z.object({
  role: z.enum(pageElementRoles),
  readAloud: z.boolean(),
  geometry: geometrySchema.nullable().optional(),
  active: z.boolean().optional(),
  includeInToc: z.boolean().nullable().optional(),
  imageWidth: z.number().finite().min(1).max(100).nullable().optional()
}).strict();

export function normalizeParagraphMetadata(metadata: readonly ParagraphElementMetadata[] | undefined, count: number): ParagraphElementMetadata[] {
  if (metadata !== undefined && metadata.length !== count) {
    throw Object.assign(new Error("paragraphMetadata debe corresponder exactamente a los parrafos de salida."), { statusCode: 400 });
  }
  return Array.from({ length: count }, (_, index) => metadata === undefined
    ? { role: "body", readAloud: true, geometry: null }
    : paragraphElementMetadataSchema.parse(metadata[index]));
}

export function annotatePageElementHtml(html: string | null, paragraphs: readonly (ParagraphElementMetadata & { paragraphNumber: number })[]): string | null {
  if (!html) return html;
  const document = load(html, {}, false);
  document("[data-element-role], [data-read-aloud], [data-element-geometry], [data-active], [data-include-in-toc], [data-image-width]")
    .removeAttr("data-element-role data-read-aloud data-element-geometry data-active data-include-in-toc data-image-width");
  document("[data-paragraph-number]").each((_, node) => {
    const element = document(node);
    const paragraph = paragraphs.find((item) => item.paragraphNumber === Number(element.attr("data-paragraph-number")));
    if (!paragraph) return;
    const existingStyle = element.attr("style");
    element.removeAttr("style");
    element.attr("data-element-role", paragraph.role).attr("data-read-aloud", String(paragraph.readAloud));
    element.attr("data-active", String(paragraph.active !== false));
    if (paragraph.includeInToc != null) element.attr("data-include-in-toc", String(paragraph.includeInToc));
    else element.removeAttr("data-include-in-toc");
    if (paragraph.imageWidth != null) {
      element.attr("data-image-width", String(paragraph.imageWidth));
      const style = (existingStyle ?? "").replace(/--reader-image-width\s*:[^;]+;?/gu, "").replace(/;+$/u, "");
      element.attr("style", `${style ? style + ";" : ""}--reader-image-width:${paragraph.imageWidth}%;`);
    } else {
      element.removeAttr("data-image-width");
      if (existingStyle) element.attr("style", existingStyle.replace(/--reader-image-width\s*:[^;]+;?/gu, ""));
    }
    if (paragraph.geometry) element.attr("data-element-geometry", JSON.stringify(paragraph.geometry));
  });
  document("[data-reading-block-id]").each((_, node) => {
    const block = document(node);
    const boxes = block.find("[data-paragraph-number]").toArray().flatMap((child) => {
      const paragraph = paragraphs.find((item) => item.paragraphNumber === Number(document(child).attr("data-paragraph-number")));
      return paragraph?.geometry ? [paragraph.geometry.bbox] : [];
    });
    if (!boxes.length) return;
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    block.attr("data-element-geometry", JSON.stringify({ bbox: {
      left, top, width: Math.max(...boxes.map((box) => box.left + box.width)) - left,
      height: Math.max(...boxes.map((box) => box.top + box.height)) - top
    } }));
  });
  return document.html();
}

export function projectActivePageHtml(
  html: string | null,
  paragraphs: readonly { paragraphNumber: number; active?: boolean | number | undefined }[]
): string | null {
  if (!html) return html;
  const inactive = new Set(paragraphs.filter((paragraph) => paragraph.active === false || paragraph.active === 0).map((paragraph) => paragraph.paragraphNumber));
  if (!inactive.size) return html;
  const document = load(html, {}, false);
  document("[data-paragraph-number]").each((_, node) => {
    if (inactive.has(Number(document(node).attr("data-paragraph-number")))) document(node).remove();
  });
  document(".reader-reading-block, .reader-reading-row, .reader-reading-column, [data-layout-id]").toArray().reverse().forEach((node) => {
    const element = document(node);
    if (!element.find("[data-paragraph-number], img, image").length && !element.text().trim()) element.remove();
  });
  return document.html();
}

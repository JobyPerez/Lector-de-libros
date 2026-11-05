import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
// Standard PDF fonts are often not embedded. Without the shipped font data,
// server-side rendering can silently omit their glyphs from the original view.
export const pdfAssetOptions = {
  standardFontDataUrl: join(root, "standard_fonts") + sep,
  cMapUrl: join(root, "cmaps") + sep,
  cMapPacked: true,
  isEvalSupported: false
};

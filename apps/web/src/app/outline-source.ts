import type { BookOutlineSource } from "./api";

export type OutlineSourceMeta = {
  badgeLabel: string;
  description: string;
};

export function getOutlineSourceMeta(source: BookOutlineSource): OutlineSourceMeta | null {
  switch (source) {
    case "EPUB_TOC":
      return {
        badgeLabel: "TOC EPUB",
        description: "Tomado del TOC interno del EPUB."
      };
    case "GENERATED_HEADINGS":
      return {
        badgeLabel: "Derivado",
        description: "Generado a partir de encabezados del contenido."
      };
    case "MANUAL":
      return {
        badgeLabel: "Manual",
        description: "Fijado manualmente en la app."
      };
    case "NONE":
    default:
      return null;
  }
}
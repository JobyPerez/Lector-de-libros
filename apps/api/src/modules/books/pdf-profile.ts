import sharp from "sharp";
import { z } from "zod";
import type { HydratableContentImage } from "./content-images.js";

export const pdfProfileSchema = z.enum(["original", "balanced", "compact", "text-only"]);
export type PdfProfile = z.infer<typeof pdfProfileSchema>;
export const pdfExportQuerySchema = z.object({ profile: pdfProfileSchema.default("original") });

export function validatePdfProfile(format: string, profile: PdfProfile) {
  if ((profile === "text-only" && format !== "pdf") || (format === "epub" && profile !== "original")) {
    throw Object.assign(new Error("La opción de calidad seleccionada no está disponible para este formato."), { statusCode: 400 });
  }
}

export async function optimizePdfImage(image: HydratableContentImage, profile: PdfProfile): Promise<HydratableContentImage & { originalWidth?: number }> {
  if (profile === "original" || profile === "text-only" || image.mimeType === "image/svg+xml") return image;
  const metadata = await sharp(image.buffer).metadata();
  const edge = profile === "balanced" ? 2200 : 1400;
  const buffer = await sharp(image.buffer).rotate()
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: profile === "balanced" ? 78 : 58, mozjpeg: true }).toBuffer();
  if (buffer.length >= image.buffer.length) return image;
  return {
    buffer, mimeType: "image/jpeg",
    originalWidth: (metadata.orientation ?? 1) >= 5 ? metadata.height : metadata.width
  };
}

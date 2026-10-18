import { externalizeContentImages, hydrateContentImages, type HydratableContentImage } from "./content-images.js";
import { load } from "cheerio";
import { optimizePdfImage, type PdfProfile } from "./pdf-profile.js";

// Keep binary images out of both the document string and Playwright's JSON messages.
// The renderer serves only these in-memory resources; it never accesses the network.
export function preparePdfAssets(sheets: string[], contentImages: ReadonlyMap<string, HydratableContentImage> = new Map()) {
  const externalized = externalizeContentImages(sheets);
  const images = new Map(contentImages);
  for (const asset of externalized.assets) images.set(asset.assetId, asset);
  const resources = new Map<string, HydratableContentImage>();
  const references = new Map<string, string>();
  for (const [assetId, image] of images) {
    const url = `https://lector-pdf-assets.invalid/${encodeURIComponent(assetId)}`;
    resources.set(url, image);
    references.set(assetId, url);
  }
  const preparedSheets = externalized.contents.map((sheet) => hydrateContentImages(sheet, references));
  const referencedUrls = new Set(preparedSheets.flatMap((sheet) => sheet.match(/https:\/\/lector-pdf-assets\.invalid\/[^\s"'<>)]*/gu) ?? []));
  for (const url of resources.keys()) if (!referencedUrls.has(url)) resources.delete(url);
  return { sheets: preparedSheets, resources };
}

export async function optimizePdfAssets(assets: ReturnType<typeof preparePdfAssets>, profile: PdfProfile) {
  if (profile === "original" || profile === "text-only") return assets;
  const widths = new Map<string, number>();
  // Sequential processing bounds memory when a book contains hundreds of large scans.
  for (const [url, image] of assets.resources) {
    const optimized = await optimizePdfImage(image, profile);
    assets.resources.set(url, optimized);
    if (optimized.originalWidth) widths.set(url, optimized.originalWidth);
  }
  return {
    resources: assets.resources,
    sheets: assets.sheets.map((sheet) => {
      const html = load(sheet, null, false);
      html("img").each((_, node) => {
        const image = html(node);
        const width = widths.get(image.attr("src") ?? "");
        // Preserve the original layout even when the delivered raster is smaller.
        if (width && !image.attr("width")) image.attr("width", String(width));
      });
      return html.html();
    })
  };
}

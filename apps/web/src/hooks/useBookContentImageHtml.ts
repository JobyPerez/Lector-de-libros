import { useEffect, useMemo, useState } from "react";

import { fetchBookContentImage } from "../app/api";

const contentImageReferencePattern = /lector-content-image:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/giu;

// Píxel transparente de 1x1: evita que el navegador intente resolver el esquema
// personalizado `lector-content-image:` (ERR_UNKNOWN_URL_SCHEME) mientras las
// imágenes se descargan e hidratan como blob URLs.
const PENDING_CONTENT_IMAGE_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export function getBookContentImageAssetIds(htmlContent: string | null | undefined): string[] {
  if (!htmlContent) {
    return [];
  }

  const assetIds = new Set<string>();
  for (const match of htmlContent.matchAll(contentImageReferencePattern)) {
    if (match[1]) {
      assetIds.add(match[1]);
    }
  }
  return Array.from(assetIds).sort();
}

export function replaceBookContentImageReferences(htmlContent: string, imageUrls: ReadonlyMap<string, string>): string {
  return htmlContent.replace(contentImageReferencePattern, (reference, assetId: string) => imageUrls.get(assetId) ?? reference);
}

export function replacePendingBookContentImageReferences(htmlContent: string): string {
  return htmlContent.replace(contentImageReferencePattern, PENDING_CONTENT_IMAGE_PLACEHOLDER);
}

type HydratedImageUrls = {
  contextKey: string;
  urls: Map<string, string>;
};

export function useBookContentImageHtml(
  htmlContent: string | null,
  accessToken: string | null,
  bookId: string | null | undefined
): string | null {
  const assetIds = useMemo(() => getBookContentImageAssetIds(htmlContent), [htmlContent]);
  const assetIdsKey = assetIds.join(",");
  const contextKey = `${accessToken ?? ""}\u0000${bookId ?? ""}\u0000${assetIdsKey}`;
  const [hydratedImageUrls, setHydratedImageUrls] = useState<HydratedImageUrls | null>(null);

  useEffect(() => {
    if (!accessToken || !bookId || assetIds.length === 0 || typeof URL.createObjectURL !== "function") {
      setHydratedImageUrls(null);
      return;
    }

    const controller = new AbortController();
    let objectUrls: string[] = [];

    void Promise.allSettled(assetIds.map(async (assetId) => {
      const blob = await fetchBookContentImage(accessToken, bookId, assetId, controller.signal);
      return [assetId, URL.createObjectURL(blob)] as const;
    })).then((results) => {
      const urls = new Map<string, string>();
      for (const result of results) {
        if (result.status === "fulfilled") {
          urls.set(result.value[0], result.value[1]);
        }
      }

      objectUrls = Array.from(urls.values());
      if (controller.signal.aborted) {
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
        objectUrls = [];
        return;
      }

      setHydratedImageUrls({ contextKey, urls });
    });

    return () => {
      controller.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [accessToken, assetIdsKey, bookId]);

  return useMemo(() => {
    if (!htmlContent) {
      return htmlContent;
    }

    if (hydratedImageUrls?.contextKey === contextKey) {
      return replaceBookContentImageReferences(htmlContent, hydratedImageUrls.urls);
    }

    if (assetIds.length === 0) {
      return htmlContent;
    }

    // Hidratación pendiente (descargando blobs): sustituir por placeholder para
    // que el esquema personalizado nunca llegue al DOM como src.
    return replacePendingBookContentImageReferences(htmlContent);
  }, [assetIds.length, contextKey, htmlContent, hydratedImageUrls]);
}

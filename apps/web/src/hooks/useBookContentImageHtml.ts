import { useEffect, useMemo, useState } from "react";

import { fetchBookContentImage } from "../app/api";

const contentImageReferencePattern = /lector-content-image:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/giu;

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
    if (!htmlContent || hydratedImageUrls?.contextKey !== contextKey) {
      return htmlContent;
    }

    return replaceBookContentImageReferences(htmlContent, hydratedImageUrls.urls);
  }, [contextKey, htmlContent, hydratedImageUrls]);
}

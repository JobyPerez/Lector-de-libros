import { createHash, randomUUID } from "node:crypto";

export const CONTENT_IMAGE_REFERENCE_PREFIX = "lector-content-image:";

const supportedMimeTypes = new Map([
  ["image/avif", "avif"],
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/svg+xml", "svg"],
  ["image/webp", "webp"]
]);
const dataImageHeaderPattern = /data:(image\/(?:avif|gif|jpeg|png|svg\+xml|webp));base64,/giu;
const contentImageReferencePattern = /lector-content-image:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/giu;

export type ContentImageAsset = {
  assetId: string;
  buffer: Buffer;
  checksum: string;
  fileName: string;
  mimeType: string;
  reference: string;
};

export type HydratableContentImage = {
  buffer: Buffer;
  mimeType: string;
};

function isBase64Character(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || character === "+"
    || character === "/"
    || character === "=";
}

function decodeBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 === 1) {
    return null;
  }

  const firstPadding = value.indexOf("=");
  if (firstPadding >= 0) {
    const paddingLength = value.length - firstPadding;
    if (paddingLength > 2) {
      return null;
    }
    for (let index = firstPadding; index < value.length; index += 1) {
      if (value[index] !== "=") {
        return null;
      }
    }
  }

  const paddedValue = value.padEnd(value.length + ((4 - value.length % 4) % 4), "=");
  return Buffer.from(paddedValue, "base64");
}

export function externalizeContentImages(contents: readonly string[]): { assets: ContentImageAsset[]; contents: string[] } {
  const assets: ContentImageAsset[] = [];
  const assetsByContent = new Map<string, ContentImageAsset>();
  const transformedContents = contents.map((content) => {
    const chunks: string[] = [];
    let contentOffset = 0;
    dataImageHeaderPattern.lastIndex = 0;

    for (let match = dataImageHeaderPattern.exec(content); match; match = dataImageHeaderPattern.exec(content)) {
      const mimeType = match[1]?.toLowerCase() ?? "";
      const base64Start = dataImageHeaderPattern.lastIndex;
      let base64End = base64Start;
      while (base64End < content.length && isBase64Character(content[base64End] ?? "")) {
        base64End += 1;
      }

      const extension = supportedMimeTypes.get(mimeType);
      const buffer = extension ? decodeBase64(content.slice(base64Start, base64End)) : null;
      if (!extension || !buffer) {
        dataImageHeaderPattern.lastIndex = base64End;
        continue;
      }

      const checksum = createHash("sha256").update(buffer).digest("hex");
      const deduplicationKey = `${mimeType}:${checksum}`;
      let asset = assetsByContent.get(deduplicationKey);
      if (!asset) {
        const assetId = randomUUID();
        asset = {
          assetId,
          buffer,
          checksum,
          fileName: `content-image-${assetId}.${extension}`,
          mimeType,
          reference: `${CONTENT_IMAGE_REFERENCE_PREFIX}${assetId}`
        };
        assetsByContent.set(deduplicationKey, asset);
        assets.push(asset);
      }

      chunks.push(content.slice(contentOffset, match.index), asset.reference);
      contentOffset = base64End;
      dataImageHeaderPattern.lastIndex = base64End;
    }

    if (contentOffset === 0) {
      return content;
    }
    chunks.push(content.slice(contentOffset));
    return chunks.join("");
  });

  return { assets, contents: transformedContents };
}

export function hydrateContentImages(
  content: string,
  images: ReadonlyMap<string, HydratableContentImage | string>
): string {
  return content.replace(contentImageReferencePattern, (reference, assetId: string) => {
    const image = images.get(reference) ?? images.get(assetId.toLowerCase()) ?? images.get(assetId);
    if (!image) {
      return reference;
    }
    if (typeof image === "string") {
      return image;
    }
    if (!supportedMimeTypes.has(image.mimeType.toLowerCase())) {
      return reference;
    }
    return `data:${image.mimeType.toLowerCase()};base64,${image.buffer.toString("base64")}`;
  });
}

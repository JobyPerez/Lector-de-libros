import { createHash } from "node:crypto";
import sharp from "sharp";

type CoverThumbnail = { buffer: Buffer; etag: string };
type CacheEntry = { value: CoverThumbnail | null; expiresAt: number };

// Per-process, bounded cache: never retain the full-size originals or trust a client version.
export class CoverThumbnailCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<CoverThumbnail | null>>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly maxEntries = 128,
    private readonly now = Date.now
  ) {}

  async get(bookId: string, version: string, load: () => Promise<Buffer | null>): Promise<CoverThumbnail | null> {
    const key = JSON.stringify([bookId, version]);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value;
    }
    if (cached) this.remove(key);
    const pending = this.pending.get(key);
    if (pending) return pending;

    const work = (async () => {
      const source = await load();
      const buffer = source ? await sharp(source).autoOrient()
        .resize({ width: 360, height: 520, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 75 }).toBuffer() : null;
      const value = buffer ? { buffer, etag: `"${createHash("sha256").update(buffer).digest("hex")}"` } : null;
      const size = buffer?.length ?? 0;
      if (size <= this.maxBytes) {
        while (this.entries.size && (this.bytes + size > this.maxBytes || this.entries.size >= this.maxEntries)) {
          this.remove(this.entries.keys().next().value!);
        }
        this.entries.set(key, { value, expiresAt: this.now() + (value ? 300_000 : 60_000) });
        this.bytes += size;
      }
      return value;
    })();
    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      this.pending.delete(key);
    }
  }

  private remove(key: string) {
    this.bytes -= this.entries.get(key)?.value?.buffer.length ?? 0;
    this.entries.delete(key);
  }
}

export const coverThumbnailCache = new CoverThumbnailCache();

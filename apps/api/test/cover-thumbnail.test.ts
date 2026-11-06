import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";
import { CoverThumbnailCache } from "../src/modules/books/cover-thumbnail.js";

const source = () => sharp({ create: { width: 1600, height: 2400, channels: 3, background: "#537c92" } }).png().toBuffer();

test("cover thumbnails are small WebP images, preserve proportions and never modify the source", async () => {
  const original = await source();
  const copy = Buffer.from(original);
  const thumbnail = await new CoverThumbnailCache().get("book", "v1", async () => original);
  assert.ok(thumbnail);
  const metadata = await sharp(thumbnail.buffer).metadata();
  assert.equal(metadata.format, "webp");
  assert.ok(metadata.width! <= 360 && metadata.height! <= 520);
  assert.ok(Math.abs(metadata.width! / metadata.height! - 2 / 3) < 0.005);
  assert.ok(thumbnail.buffer.length < original.length);
  assert.deepEqual(original, copy);
  assert.match(thumbnail.etag, /^"[a-f0-9]{64}"$/);
  const small = await sharp({ create: { width: 20, height: 30, channels: 3, background: "red" } }).png().toBuffer();
  const result = await new CoverThumbnailCache().get("small", "v1", async () => small);
  assert.equal((await sharp(result!.buffer).metadata()).width, 20);
});

test("cache shares concurrent work, reuses thumbnails and reloads on version change or expiry", async () => {
  let now = 0;
  const cache = new CoverThumbnailCache(undefined, undefined, () => now);
  let loads = 0;
  const load = async () => { loads++; return source(); };
  const [first, second] = await Promise.all([cache.get("book", "v1", load), cache.get("book", "v1", load)]);
  assert.equal(loads, 1);
  assert.equal(first, second);
  assert.equal(await cache.get("book", "v1", load), first);
  await cache.get("book", "v2", load);
  assert.equal(loads, 2);
  now = 300_001;
  await cache.get("book", "v2", load);
  assert.equal(loads, 3);
});

test("missing covers are cached briefly, errors can retry, and cache limits evict old entries", async () => {
  let now = 0;
  let loads = 0;
  const cache = new CoverThumbnailCache(1024 * 1024, 2, () => now);
  const missing = async () => { loads++; return null; };
  await cache.get("missing", "v1", missing);
  await cache.get("missing", "v1", missing);
  assert.equal(loads, 1);
  now = 60_001;
  await cache.get("missing", "v1", missing);
  assert.equal(loads, 2);
  await assert.rejects(cache.get("error", "v1", async () => { throw new Error("temporary"); }), /temporary/);
  await cache.get("error", "v1", missing);
  await cache.get("third", "v1", missing);
  await cache.get("missing", "v1", missing);
  assert.equal(loads, 5, "entry-count limit evicts the least recently used cover");

  const tiny = new CoverThumbnailCache(1);
  let largeLoads = 0;
  const large = async () => { largeLoads++; return source(); };
  await tiny.get("book", "v1", large);
  await tiny.get("book", "v1", large);
  assert.equal(largeLoads, 2, "oversized entries do not exceed the byte limit");
});

const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
function route(dependencies: Record<string, unknown>) {
  const start = routes.indexOf('  app.get("/:bookId/cover",');
  const end = routes.indexOf("\n  });", start);
  const body = routes.slice(start, end).split("async (request, reply) => {")[1];
  return new Function(...Object.keys(dependencies), ts.transpile(`return async (request, reply) => {${body}\n};`, { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
}
function reply() {
  return { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    header(key: string, value: string) { this.headers[key] = value; return this; },
    send(value?: unknown) { this.body = value; return this; } };
}

test("cover endpoint checks access before cached reads, uses server versions, supports 304 and preserves originals", async () => {
  const original = await source();
  let accessible = true;
  let version = "server-v1";
  let loads = 0;
  let closes = 0;
  const cache = new CoverThumbnailCache();
  const run = route({ z, bookParamsSchema: z.object({ bookId: z.string() }),
    getConnection: async () => ({ close: async () => { closes++; } }),
    findAccessibleBook: async () => accessible ? { bookId: "book", updatedAt: version } : null,
    coverThumbnailCache: cache,
    resolveBookCoverAsset: async () => { loads++; return { contentBlob: original, mimeType: "image/png" }; }
  });
  const request = { currentUser: { userId: "user" }, params: { bookId: "book" }, query: { thumbnail: "true", v: "untrusted" }, headers: {} };
  const first = reply();
  await run(request, first);
  assert.equal(first.headers["Content-Type"], "image/webp");
  assert.equal(first.headers["Cache-Control"], "private, max-age=300");
  assert.equal(first.headers.Vary, "Authorization");
  assert.equal(loads, 1);
  const conditional = reply();
  await run({ ...request, headers: { "if-none-match": `"other", W/${first.headers.ETag}` } }, conditional);
  assert.equal(conditional.statusCode, 304);
  assert.equal(conditional.body, undefined);
  assert.equal(loads, 1);
  accessible = false;
  const forbidden = reply();
  await run(request, forbidden);
  assert.equal(forbidden.statusCode, 404);
  assert.equal(loads, 1);
  accessible = true;
  version = "server-v2";
  await run(request, reply());
  assert.equal(loads, 2);
  const full = reply();
  await run({ ...request, query: {} }, full);
  assert.equal(full.body, original);
  assert.equal(full.headers["Content-Type"], "image/png");
  assert.equal(full.headers["Cache-Control"], "private, no-cache");
  assert.equal(closes, 5);
  const unauthenticated = reply();
  await run({ ...request, currentUser: undefined }, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);
});

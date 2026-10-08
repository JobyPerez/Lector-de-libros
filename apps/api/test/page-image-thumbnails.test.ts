import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";

const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const bookId = randomUUID(), pageId = randomUUID();
const path = "/:bookId/pages/:pageNumber/image";
const start = routes.indexOf(`  app.get("${path}",`), end = routes.indexOf("\n  });", start);
assert.ok(start >= 0 && end > start);
const body = routes.slice(start, end).split("async (request, reply) => {")[1];
const compiled = ts.transpile(`return async (request, reply) => {${body}\n};`, { target: ts.ScriptTarget.ES2022 });

function fixture(buffer: Buffer, rotation = 0) {
  const image = { contentBlob: buffer, mimeType: "image/png", checksum: "source-checksum" as string | null,
    fileId: randomUUID(), pageId, sourceImageRotation: rotation, updatedAt: "2026-10-08T12:00:00.000001" };
  const calls: { sql: string; binds: any }[] = [];
  let closed = 0;
  const connection = { execute: async (sql: string, binds: any) => {
    calls.push({ sql, binds });
    assert.match(sql, /bp\.source_image_rotation AS "sourceImageRotation"/);
    assert.match(sql, /bf\.checksum_sha256 AS "checksum"/);
    assert.match(sql, /:pageId IS NOT NULL AND bp.page_id = :pageId/);
    assert.match(sql, /bf.book_id = bp.book_id/);
    assert.equal(binds.bookId, bookId);
    return { rows: binds.pageId && binds.pageId !== pageId ? [] : [image] };
  }, close: async () => { closed++; } };
  const handler = new Function("z", "pageParamsSchema", "getConnection", "oracledb", "sharp", "createHash", compiled)(
    z, z.object({ bookId: z.string().uuid(), pageNumber: z.coerce.number().int().min(1) }),
    async () => connection, { BUFFER: 1 }, sharp, createHash
  );
  return { image, calls, handler, get closed() { return closed; }, call: async (query: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    const reply = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as Buffer | undefined,
      status(code: number) { this.statusCode = code; return this; },
      header(name: string, value: string) { this.headers[name] = value; return this; },
      send(value?: any) { this.body = value; return this; } };
    await handler({ params: { bookId, pageNumber: 1 }, query, headers, currentUser: { userId: "viewer" } }, reply);
    return reply;
  } };
}

const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "red" } }).png().toBuffer();

test("gallery thumbnails are real quality-75 WebP bounded to 360x480 and use stored rotation", async () => {
  const source = await png(1600, 800);
  for (const [rotation, width, height] of [[0, 360, 180], [90, 240, 480], [180, 360, 180], [270, 240, 480]]) {
    const app = fixture(source, rotation!);
    const response = await app.call({ thumbnail: "true", pageId });
    assert.equal(response.statusCode, 200); assert.equal(response.headers["Content-Type"], "image/webp");
    const metadata = await sharp(response.body).metadata();
    assert.equal(metadata.format, "webp"); assert.equal(metadata.width, width); assert.equal(metadata.height, height);
    assert.ok(response.body!.length < source.length);
    assert.equal(app.closed, 1);
  }
  assert.match(body!, /\.webp\(\{ quality: 75 \}\)/);
});

test("thumbnail rotation is clockwise and preserves the complete image rather than cropping", async () => {
  const blue = await sharp({ create: { width: 100, height: 100, channels: 3, background: "blue" } }).png().toBuffer();
  const source = await sharp({ create: { width: 200, height: 100, channels: 3, background: "red" } })
    .composite([{ input: blue, left: 100, top: 0 }]).png().toBuffer();
  const response = await fixture(source, 90).call({ thumbnail: "true" });
  const { data, info } = await sharp(response.body).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 100); assert.equal(info.height, 200);
  const top = (10 * info.width + 50) * info.channels, bottom = (190 * info.width + 50) * info.channels;
  assert.ok(data[top]! > 200 && data[top + 2]! < 50, "left red half must rotate to the top");
  assert.ok(data[bottom + 2]! > 200 && data[bottom]! < 50, "right blue half must rotate to the bottom");
});

test("small thumbnails are not enlarged; EXIF orientation is applied before page rotation", async () => {
  const source = await png(80, 40);
  for (const rotation of [0, 90]) {
    const response = await fixture(source, rotation).call({ thumbnail: "true" });
    const metadata = await sharp(response.body).metadata();
    assert.equal(metadata.width, rotation ? 40 : 80); assert.equal(metadata.height, rotation ? 80 : 40);
  }
  const oriented = await sharp(await png(200, 100)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const app = fixture(oriented); app.image.mimeType = "image/jpeg";
  const response = await app.call({ thumbnail: "true" });
  const metadata = await sharp(response.body).metadata();
  assert.equal(metadata.width, 100); assert.equal(metadata.height, 200); assert.equal(metadata.orientation, undefined);
});

test("legacy/full-image and original requests remain byte-for-byte unchanged", async () => {
  const source = await png(800, 1600), app = fixture(source, 90);
  for (const query of [{}, { thumbnail: "false" }, { original: "true" }, { original: "true", thumbnail: "false" }]) {
    const response = await app.call(query);
    assert.deepEqual(response.body, source); assert.equal(response.headers["Content-Type"], "image/png");
    assert.equal(response.headers.ETag, undefined); assert.equal(response.headers["Cache-Control"], "private, no-cache");
  }
  const thumbnail = await app.call({ original: "true", thumbnail: "true" });
  assert.equal(thumbnail.headers["Content-Type"], "image/webp"); assert.equal(app.calls.at(-1)!.binds.original, 1);
});

test("thumbnail ETags cover checksum, rotation, page version and variant, with weak/list/star revalidation before encoding", async () => {
  const source = await png(800, 1200), app = fixture(source);
  const response = await app.call({ thumbnail: "true" });
  const etag = response.headers.ETag!;
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  assert.equal(response.headers["Cache-Control"], "private, no-cache");
  app.image.contentBlob = Buffer.from("undecodable source: matching ETag must not encode");
  for (const header of [etag, `"other", W/${etag}`, "*"]) {
    const cached = await app.call({ thumbnail: "true" }, { "if-none-match": header });
    assert.equal(cached.statusCode, 304); assert.equal(cached.body, undefined); assert.equal(cached.headers.ETag, etag);
  }
  app.image.contentBlob = source;
  for (const mutate of [() => { app.image.checksum = "changed"; }, () => { app.image.sourceImageRotation = 90; },
    () => { app.image.updatedAt = "2026-10-08T12:00:00.000002"; }]) {
    mutate(); const next = await app.call({ thumbnail: "true" }, { "if-none-match": etag });
    assert.equal(next.statusCode, 200); assert.notEqual(next.headers.ETag, etag);
  }
  const current = await app.call({ thumbnail: "true" });
  const original = await app.call({ thumbnail: "true", original: "true" });
  assert.notEqual(current.headers.ETag, original.headers.ETag);
  app.image.checksum = null;
  const fallback = await app.call({ thumbnail: "true" });
  app.image.contentBlob = await png(600, 900);
  assert.notEqual((await app.call({ thumbnail: "true" })).headers.ETag, fallback.headers.ETag);
});

test("thumbnail flag is validated and foreign stable page IDs never fall back to a numeric page", async () => {
  const app = fixture(await png(10, 20));
  await assert.rejects(app.call({ thumbnail: "invalid" })); assert.equal(app.calls.length, 0);
  const foreign = await app.call({ thumbnail: "true", pageId: randomUUID() });
  assert.equal(foreign.statusCode, 404);
  app.image.mimeType = "application/pdf";
  assert.equal((await app.call({ thumbnail: "true" })).statusCode, 409);
});

test("VIEWER authorization is preserved and cache hits cannot bypass book access", async () => {
  assert.match(routes.slice(start, end), /preHandler: \[authenticateRequest, requireBookRole\("VIEWER"\)\]/);
  const accessSource = readFileSync(new URL("../src/services/book-access.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("book-access.ts", accessSource, ts.ScriptTarget.Latest, true);
  const guardNode = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "requireBookRole");
  assert.ok(guardNode);
  const guard = new Function("resolveBookAccess", "roleAtLeast", ts.transpile(`${guardNode.getText(tree).replace(/^export /u, "")}; return requireBookRole;`, { target: ts.ScriptTarget.ES2022 }))(
    async (_book: string, user: string) => user === "viewer" ? { role: "VIEWER" } : null,
    (role: string, minimum: string) => role === "VIEWER" && minimum === "VIEWER"
  );
  const fixtureApp = fixture(await png(40, 80)), app = Fastify();
  app.get(path, { preHandler: [async (request) => {
    if (request.headers.authorization) request.currentUser = { userId: request.headers.authorization } as any;
  }, guard("VIEWER")] }, fixtureApp.handler);
  try {
    const url = `/${bookId}/pages/1/image?thumbnail=true`;
    const response = await app.inject({ url, headers: { authorization: "viewer" } });
    assert.equal(response.statusCode, 200); assert.equal(response.headers["content-type"], "image/webp");
    fixtureApp.calls.length = 0;
    for (const headers of [{ "if-none-match": response.headers.etag! }, { authorization: "outsider", "if-none-match": response.headers.etag! }]) {
      const denied = await app.inject({ url, headers });
      assert.equal(denied.statusCode, "authorization" in headers ? 404 : 401); assert.equal(fixtureApp.calls.length, 0);
    }
  } finally { await app.close(); }
});

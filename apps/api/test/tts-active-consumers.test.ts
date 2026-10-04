import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import cors from "@fastify/cors";
import Fastify from "fastify";
import oracledb from "oracledb";

import { closeConnectionPool, initializeConnectionPool } from "../src/config/database.js";
import { registerTtsRoutes } from "../src/modules/tts/tts.routes.js";

const bookId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const requestId = "10000000-0000-4000-8000-000000000003";

test("TTS selects active narration and rejects inactive or stale cached content", async (t) => {
  const paragraphs = [
    { sequenceNumber: 1, isActive: 0, readAloud: 1 },
    { sequenceNumber: 2, isActive: 1, readAloud: 0 },
    { sequenceNumber: 3, isActive: 1, readAloud: 1 },
    { sequenceNumber: 4, isActive: 0, readAloud: 1 },
    { sequenceNumber: 6, isActive: 1, readAloud: 1 },
    { sequenceNumber: 8, isActive: 0, readAloud: 1 },
    { sequenceNumber: 10, isActive: 1, readAloud: 1 },
    { sequenceNumber: 12, isActive: 0, readAloud: 1 }
  ].map((p) => ({
    ...p,
    bookId,
    pageNumber: p.sequenceNumber,
    paragraphNumber: 1,
    paragraphId: `20000000-0000-4000-8000-${String(p.sequenceNumber).padStart(12, "0")}`,
    paragraphText: `Text ${p.sequenceNumber}.`,
    cachedAudioBlob: Buffer.from(`audio-${p.sequenceNumber}`),
    cachedAudioMimeType: "audio/mpeg",
    cachedTextChecksum: createHash("sha256").update(`Text ${p.sequenceNumber}.`).digest("hex")
  }));
  let isStale = 1;
  const queries: string[] = [];
  const connection = {
    async execute(sql: string, binds: Record<string, any> = {}) {
      queries.push(sql);
      if (sql.startsWith("ALTER SESSION")) return {};
      if (sql.includes('AS "shareRole"')) return { rows: [{ ownerUserId: "other", shareRole: "viewer", shareUserAnnotations: "N" }] };
      if (sql.includes("ai_credential_shares")) return { rows: [] };
      if (sql.includes("FROM users")) return { rows: [{ deepgramApiKeyEncrypted: null, deepgramTtsModel: "aura-2-nestor-es", deepgramTtsModelIt: "aura-2-livia-it" }] };
      if (sql.includes("FROM user_book_section_summaries")) {
        assert.match(sql, /uss\.is_stale = 0/);
        return { rows: isStale ? [] : [{ summaryText: "Current summary" }] };
      }
      if (sql.includes("FROM user_book_ai_requests")) {
        assert.match(sql, /ar\.is_stale = 0/);
        return { rows: isStale ? [] : [{
          bookId, requestId, requestKind: "TEXT", responseText: "Current response",
          cachedAudioBlob: Buffer.from("response-audio"), cachedAudioMimeType: "audio/mpeg",
          cachedTextChecksum: createHash("sha256").update("Current response").digest("hex")
        }] };
      }
      if (sql.includes("FROM books")) return { rows: [{ title: "Book", languageCode: "es" }] };
      if (sql.includes("FROM book_pages")) return { rows: [1, 2, 10].map((pageNumber) => ({ pageNumber, htmlContent: '<h1 data-paragraph-number="1">Chapter</h1>' })) };
      if (sql.includes('AS "nextSequenceNumber"')) {
        assert.match(sql, /is_active = 1\s+AND read_aloud = 1/);
        return { rows: [{ nextSequenceNumber: paragraphs.find((p) => p.isActive === 1 && p.readAloud === 1 && p.sequenceNumber > binds.lastSequenceNumber)?.sequenceNumber ?? null }] };
      }
      if (sql.includes("FROM book_paragraphs")) {
        if (binds.paragraphId) {
          assert.match(sql, /bp\.is_active AS "isActive"/);
          assert.doesNotMatch(sql, /AND bp\.is_active = 1/);
          return { rows: paragraphs.filter((p) => p.paragraphId === binds.paragraphId) };
        }
        if (binds.startSequenceNumber !== undefined) {
          assert.match(sql, /bp\.is_active = 1\s+AND bp\.read_aloud = 1/);
          const isBlock = binds.paragraphCount !== undefined;
          const selected = paragraphs.filter((p) => p.isActive === 1 && p.readAloud === 1
            && p.sequenceNumber >= binds.startSequenceNumber
            && (binds.endSequenceNumber === undefined || (isBlock ? p.sequenceNumber <= binds.endSequenceNumber : p.sequenceNumber < binds.endSequenceNumber)));
          return { rows: isBlock ? selected.slice(0, binds.paragraphCount) : selected };
        }
        assert.match(sql, /is_active AS "active"/);
        assert.match(sql, /include_in_toc AS "includeInToc"/);
        return { rows: paragraphs.map((p) => ({ ...p, active: p.isActive })) };
      }
      assert.fail(`Unexpected SQL: ${sql}`);
    },
    async close() {},
    async commit() { assert.fail("Cached audio must not be changed"); },
    async rollback() {}
  };
  t.mock.method(oracledb, "createPool", async () => ({ getConnection: async () => connection, close: async () => {} }));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { assert.fail("Must not call a provider"); });
  await initializeConnectionPool();
  const app = Fastify();
  t.after(async () => { await app.close(); await closeConnectionPool(); });
  await app.register(cors, { exposedHeaders: ["X-Reader-Tts-Paragraphs", "X-Reader-Tts-Next-Sequence"] });
  app.addHook("onRoute", (route) => {
    if (Array.isArray(route.preHandler)) route.preHandler[0] = async (request) => {
      request.currentUser = { userId } as NonNullable<typeof request.currentUser>;
    };
  });
  await app.register(registerTtsRoutes);

  await t.test("inactive read-aloud paragraph rejects valid cache without a provider key", async () => {
    const response = await app.inject({ method: "POST", url: `/books/${bookId}/tts`, payload: { paragraphId: paragraphs[0]!.paragraphId } });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().message, /activo/);
    assert.equal(response.headers["cache-control"], undefined);
    assert.ok(!response.body.includes("audio-1"));
    const active = await app.inject({ method: "POST", url: `/books/${bookId}/tts`, payload: { paragraphId: paragraphs[2]!.paragraphId } });
    assert.equal(active.statusCode, 200);
    assert.equal(active.body, "audio-3");
  });

  await t.test("block metadata and next cursor preserve actual IDs across inactive and muted gaps", async () => {
    const response = await app.inject({ method: "POST", url: `/books/${bookId}/tts/block`, payload: { startSequenceNumber: 1, paragraphCount: 2, endSequenceNumber: 6 } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "audio-3audio-6");
    const metadata = JSON.parse(Buffer.from(String(response.headers["x-reader-tts-paragraphs"]), "base64url").toString());
    assert.deepEqual(metadata.map((p: { paragraphId: string; sequenceNumber: number }) => [p.paragraphId, p.sequenceNumber]), paragraphs.filter((p) => [3, 6].includes(p.sequenceNumber)).map((p) => [p.paragraphId, p.sequenceNumber]));
    assert.equal(response.headers["x-reader-tts-next-sequence"], "10");
    assert.match(String(response.headers["access-control-expose-headers"]), /X-Reader-Tts-Next-Sequence/);
    const last = await app.inject({ method: "POST", url: `/books/${bookId}/tts/block`, payload: { startSequenceNumber: 7 } });
    assert.equal(last.body, "audio-10");
    assert.equal(last.headers["x-reader-tts-next-sequence"], "");
    const empty = await app.inject({ method: "POST", url: `/books/${bookId}/tts/block`, payload: { startSequenceNumber: 11 } });
    assert.equal(empty.statusCode, 404);
  });

  await t.test("offline plan excludes inactive headings and narration but retains muted active sections", async () => {
    const response = await app.inject({ method: "GET", url: `/books/${bookId}/sections/${paragraphs[1]!.paragraphId}/tts/offline-plan` });
    assert.equal(response.statusCode, 200);
    const plan = response.json();
    assert.equal(plan.paragraphCount, 2);
    assert.deepEqual(plan.blocks.map((block: { startSequenceNumber: number; paragraphCount: number }) => [block.startSequenceNumber, block.paragraphCount]), [[3, 2]]);
    assert.equal(plan.endSequenceNumber, 6);
    assert.equal(plan.totalCharacters, "Text 3.Text 6.".length);
    assert.equal(plan.missingCharacters, 0);
    const inactive = await app.inject({ method: "GET", url: `/books/${bookId}/sections/${paragraphs[0]!.paragraphId}/tts/offline-plan` });
    assert.equal(inactive.statusCode, 404);
  });

  await t.test("stale summary and AI response reject before cache or synthesis, current history still works", async () => {
    const summaryUrl = `/books/${bookId}/sections/${paragraphs[1]!.paragraphId}/summary/tts`;
    const responseUrl = `/books/${bookId}/ai-requests/${requestId}/tts`;
    for (const url of [summaryUrl, responseUrl]) {
      const response = await app.inject({ method: "POST", url, payload: {} });
      assert.equal(response.statusCode, 404);
      assert.equal(response.headers["cache-control"], undefined);
    }
    isStale = 0;
    const response = await app.inject({ method: "POST", url: responseUrl, payload: {} });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "response-audio");
    const summary = await app.inject({ method: "POST", url: summaryUrl, payload: {} });
    assert.equal(summary.statusCode, 503);
  });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.ok(queries.every((sql) => !/DELETE|INSERT|MERGE|UPDATE/.test(sql)));
});

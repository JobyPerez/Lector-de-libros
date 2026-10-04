import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import cors from "@fastify/cors";
import Fastify from "fastify";
import oracledb from "oracledb";

import { closeConnectionPool, initializeConnectionPool } from "../src/config/database.js";
import { buildOutlineFromTitles } from "../src/modules/books/book-outline.js";
import { registerTtsRoutes } from "../src/modules/tts/tts.routes.js";
import { normalizeTextForDeepgram } from "../src/services/paragraph-metrics.js";

const bookId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const voices = ["aura-2-nestor-es", "aura-2-carina-es"];

function paragraph(sequenceNumber: number, readAloud = 1, elementRole = "body") {
  const paragraphText = `Texto ${sequenceNumber}.`;
  return {
    bookId,
    paragraphId: `00000000-0000-4000-8000-${String(sequenceNumber).padStart(12, "0")}`,
    pageNumber: sequenceNumber,
    paragraphNumber: 1,
    sequenceNumber,
    paragraphText,
    readAloud,
    elementRole,
    cachedAudioBlob: Buffer.from(`audio-${sequenceNumber}`),
    cachedAudioMimeType: "audio/mpeg",
    cachedTextChecksum: createHash("sha256").update(normalizeTextForDeepgram(paragraphText)).digest("hex")
  };
}

test("TTS respeta read_aloud con DB simulada y acceso VIEWER", async (t) => {
  let paragraphs = [paragraph(1, 0), paragraph(2, 0), paragraph(3), paragraph(4, 0), paragraph(5), paragraph(6, 0), paragraph(7), paragraph(8, 0)];
  let headings = [1, 7];
  const queries: string[] = [];
  const connection = {
    async execute(sql: string, binds: Record<string, any> = {}) {
      queries.push(sql);
      if (sql.startsWith("ALTER SESSION")) return {};
      if (sql.includes('AS "shareRole"')) {
        return { rows: [{ ownerUserId: "other-owner", shareRole: "viewer", shareUserAnnotations: "N" }] };
      }
      if (sql.includes("ai_credential_shares")) {
        return { rows: [] };
      }
      if (sql.includes("FROM users")) {
        return { rows: [{ deepgramApiKeyEncrypted: null, deepgramTtsModel: voices[0], deepgramTtsModelIt: "aura-2-livia-it" }] };
      }
      if (sql.includes("FROM books")) return { rows: [{ title: "Libro", languageCode: "es" }] };
      if (sql.includes("FROM book_pages")) {
        return { rows: headings.map((sequence) => ({ pageNumber: sequence, htmlContent: '<h1 data-paragraph-number="1">Capitulo</h1>' })) };
      }
      if (sql.includes('AS "nextSequenceNumber"')) {
        assert.match(sql, /read_aloud = 1/);
        return { rows: [{ nextSequenceNumber: paragraphs.find((p) => p.readAloud === 1 && p.sequenceNumber > binds.lastSequenceNumber)?.sequenceNumber ?? null }] };
      }
      if (sql.includes("FROM book_paragraphs")) {
        if (binds.paragraphId) {
          assert.match(sql, /bp.read_aloud AS "readAloud"/);
          return { rows: paragraphs.filter((p) => p.paragraphId === binds.paragraphId) };
        }
        if (binds.startSequenceNumber !== undefined) {
          assert.match(sql, /bp.read_aloud = 1/);
          assert.doesNotMatch(sql, /BETWEEN/);
          const isBlock = binds.paragraphCount !== undefined;
          if (isBlock) assert.match(sql, /ORDER BY bp.sequence_number ASC\s+FETCH FIRST :paragraphCount ROWS ONLY/);
          const selected = paragraphs.filter((p) => p.readAloud === 1
            && p.sequenceNumber >= binds.startSequenceNumber
            && (binds.endSequenceNumber === undefined || (isBlock ? p.sequenceNumber <= binds.endSequenceNumber : p.sequenceNumber < binds.endSequenceNumber)));
          return { rows: isBlock ? selected.slice(0, binds.paragraphCount) : selected };
        }
        assert.match(sql, /element_role AS "elementRole"/);
        return { rows: paragraphs };
      }
      assert.fail(`SQL inesperado: ${sql}`);
    },
    async close() {},
    async commit() { assert.fail("No debe modificar audio en cache"); },
    async rollback() {}
  };
  t.mock.method(oracledb, "createPool", async () => ({ getConnection: async () => connection, close: async () => {} }));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("No debe sintetizar"); });
  await initializeConnectionPool();
  const app = Fastify();
  await app.register(cors, { exposedHeaders: ["X-Reader-Tts-Paragraphs", "X-Reader-Tts-Next-Sequence"] });
  app.addHook("onRoute", (route) => {
    if (Array.isArray(route.preHandler)) {
      // Replace authentication only; the real VIEWER authorization still runs.
      route.preHandler[0] = async (request) => {
        request.currentUser = { userId } as NonNullable<typeof request.currentUser>;
      };
    }
  });
  await app.register(registerTtsRoutes);
  t.after(async () => { await app.close(); await closeConnectionPool(); });

  for (const voiceModel of voices) {
    await t.test(`individual excluido rechaza cache sin API key: ${voiceModel}`, async () => {
      const response = await app.inject({ method: "POST", url: `/books/${bookId}/tts`, payload: { paragraphId: paragraphs[0]!.paragraphId, voiceModel } });
      assert.equal(response.statusCode, 409);
      assert.match(response.json().message, /lectura en voz alta/);
    });

    await t.test(`bloque salta excluidos iniciales e intermedios: ${voiceModel}`, async () => {
      const response = await app.inject({ method: "POST", url: `/books/${bookId}/tts/block`, payload: { startSequenceNumber: 1, paragraphCount: 2, voiceModel } });
      assert.equal(response.statusCode, 200);
      const entries = JSON.parse(Buffer.from(String(response.headers["x-reader-tts-paragraphs"]), "base64url").toString());
      assert.deepEqual(entries.map((p: { sequenceNumber: number }) => p.sequenceNumber), [3, 5]);
      assert.equal(response.headers["x-reader-tts-next-sequence"], "7");
      assert.equal(response.body, "audio-3audio-5");
      assert.match(String(response.headers["access-control-expose-headers"]), /X-Reader-Tts-Next-Sequence/);
    });
  }

  await t.test("limite inclusivo no cruza al siguiente capitulo", async () => {
    const response = await app.inject({ method: "POST", url: `/books/${bookId}/tts/block`, payload: { startSequenceNumber: 1, endSequenceNumber: 5, paragraphCount: 6 } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "audio-3audio-5");
    assert.equal(response.headers["x-reader-tts-next-sequence"], "7");
  });

  await t.test("EOS ignora excluidos finales y devuelve cursor vacio", async () => {
    const response = await app.inject({ method: "POST", url: `/books/${bookId}/tts/block`, payload: { startSequenceNumber: 6, paragraphCount: 6 } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "audio-7");
    assert.equal(response.headers["x-reader-tts-next-sequence"], "");
  });

  await t.test("plan agrupa N narrables preservando huecos y el ultimo bloque parcial", async () => {
    paragraphs = Array.from({ length: 19 }, (_, i) => paragraph(i + 1, (i + 1) % 2 === 0 ? 1 : 0));
    headings = [1, 17];
    const response = await app.inject({ method: "GET", url: `/books/${bookId}/sections/${paragraphs[0]!.paragraphId}/tts/offline-plan` });
    assert.equal(response.statusCode, 200);
    const plan = response.json();
    assert.equal(plan.paragraphCount, 8);
    assert.equal(plan.empty, false);
    assert.deepEqual(plan.blocks.map((b: { startSequenceNumber: number; paragraphCount: number }) => [b.startSequenceNumber, b.paragraphCount]), [[2, 6], [14, 2]]);
    assert.equal(plan.endSequenceNumber, 16);
    assert.equal(plan.missingCharacters, 0);
    assert.equal(plan.totalCharacters, paragraphs.filter((p) => p.readAloud === 1 && p.sequenceNumber < 17).reduce((sum, p) => sum + normalizeTextForDeepgram(p.paragraphText).length, 0));
    const last = plan.blocks.at(-1);
    const block = await app.inject({ method: "POST", url: `/books/${bookId}/tts/block`, payload: last });
    assert.equal(block.statusCode, 200);
    assert.equal(block.body, "audio-14audio-16");
  });

  await t.test("capitulo solo excluido tiene plan vacio explicito", async () => {
    paragraphs = [paragraph(1, 0, "heading"), paragraph(2, 0), paragraph(3, 1, "heading")];
    headings = [1, 3];
    const response = await app.inject({ method: "GET", url: `/books/${bookId}/sections/${paragraphs[0]!.paragraphId}/tts/offline-plan` });
    assert.equal(response.statusCode, 200);
    const plan = response.json();
    assert.deepEqual(plan.blocks, []);
    assert.equal(plan.empty, true);
    assert.equal(plan.paragraphCount, 0);
    assert.equal(plan.totalCharacters, 0);
    assert.equal(plan.estimatedCostUsd, 0);
  });

  assert.equal(fetchMock.mock.callCount(), 0);
  assert.ok(queries.length > 0);
});

test("indice excluye roles marginales pero conserva heading/body sin narracion", () => {
  const roles = ["header", "footer", "pageNumber", "heading", "body"];
  const paragraphs = roles.map((role, index) => ({ ...paragraph(index + 1, 0, role), pageNumber: 1, paragraphNumber: index + 1 }));
  const outline = buildOutlineFromTitles([{ pageNumber: 1, htmlContent: roles.map((_, index) => `<h1 data-paragraph-number="${index + 1}">Titulo ${index + 1}</h1>`).join("") }], paragraphs);
  assert.deepEqual(outline.map((entry) => entry.sequenceNumber), [4, 5]);
});

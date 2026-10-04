import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";
import oracledb from "oracledb";

import { closeConnectionPool, initializeConnectionPool } from "../src/config/database.js";
import { registerAnnotationRoutes } from "../src/modules/annotations/annotations.routes.js";

const bookId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

test("navigation metrics count only narration without changing TOC or annotation IDs", async (t) => {
  let paragraphs = [
    { sequenceNumber: 1, elementRole: "header", readAloud: 0, wordCount: 100, characterCount: 1000 },
    { sequenceNumber: 2, elementRole: "heading", readAloud: 0, wordCount: 20, characterCount: 200 },
    { sequenceNumber: 4, elementRole: "body", readAloud: 1, wordCount: 3, characterCount: 30 },
    { sequenceNumber: 6, elementRole: "footer", readAloud: 0, wordCount: 100, characterCount: 1000 },
    { sequenceNumber: 8, elementRole: "heading", readAloud: 0, wordCount: 20, characterCount: 200 },
    { sequenceNumber: 9, elementRole: "body", readAloud: 0, wordCount: 50, characterCount: 500 },
    { sequenceNumber: 12, elementRole: "heading", readAloud: 1, wordCount: 2, characterCount: 20 },
    { sequenceNumber: 15, elementRole: "body", readAloud: 1, wordCount: 5, characterCount: 50 },
    { sequenceNumber: 18, elementRole: "heading", readAloud: 0, wordCount: 20, characterCount: 200 },
    { sequenceNumber: 20, elementRole: "footer", readAloud: 0, wordCount: 100, characterCount: 1000 }
  ].map((p) => ({ ...p, pageNumber: p.sequenceNumber, paragraphNumber: 1, paragraphId: `paragraph-${p.sequenceNumber}` }));
  const visibleParagraphs = structuredClone(paragraphs);
  const bookmark = { bookmarkId: "bookmark-muted", paragraphId: "paragraph-9", sequenceNumber: 9, pageNumber: 9, paragraphNumber: 1 };
  const metricSelections: number[][] = [];
  const connection = {
    async execute(sql: string, binds: Record<string, unknown> = {}) {
      if (sql.startsWith("ALTER SESSION")) return {};
      if (sql.includes('AS "shareRole"')) {
        return { rows: [{ ownerUserId: "other-owner", shareRole: "viewer", shareUserAnnotations: "N" }] };
      }
      if (sql.includes("FROM user_bookmarks")) {
        assert.doesNotMatch(sql, /read_aloud/);
        return { rows: [bookmark] };
      }
      if (sql.includes("FROM user_highlights") || sql.includes("FROM user_notes")) return { rows: [] };
      if (sql.includes("FROM books b")) return { rows: [{ bookId, title: "Libro", totalPages: 20, shareUserAnnotations: "N" }] };
      if (sql.includes("FROM book_pages")) {
        return { rows: paragraphs.filter((p) => p.elementRole === "heading").map((p) => ({ pageNumber: p.pageNumber, htmlContent: '<h1 data-paragraph-number="1">Capitulo</h1>' })) };
      }
      if (sql.includes("FROM book_paragraphs")) {
        assert.equal(binds.bookId, bookId);
        if (sql.includes('tts_character_count AS "characterCount"')) {
          assert.match(sql, /WHERE book_id = :bookId\s+AND is_active = 1\s+AND read_aloud = 1\s+ORDER BY sequence_number ASC/);
          const selected = paragraphs.filter((p) => p.readAloud === 1);
          metricSelections.push(selected.map((p) => p.sequenceNumber));
          return { rows: selected };
        }
        assert.doesNotMatch(sql, /read_aloud\s*=/);
        return { rows: paragraphs };
      }
      assert.fail(`Unexpected SQL: ${sql}`);
    },
    async close() {}
  };
  t.mock.method(oracledb, "createPool", async () => ({ getConnection: async () => connection, close: async () => {} }));
  await initializeConnectionPool();
  const app = Fastify();
  t.after(async () => { await app.close(); await closeConnectionPool(); });
  app.addHook("onRoute", (route) => {
    if (Array.isArray(route.preHandler)) {
      route.preHandler[0] = async (request) => {
        request.currentUser = { userId } as NonNullable<typeof request.currentUser>;
      };
    }
  });
  await app.register(registerAnnotationRoutes);

  await t.test("muted headings remain in TOC and empty chapters retain global intervals", async () => {
    const response = await app.inject({ method: "GET", url: `/books/${bookId}/navigation` });
    assert.equal(response.statusCode, 200);
    const { readingMetrics, toc, bookmarks } = response.json();
    assert.deepEqual(readingMetrics.book, { wordCount: 10, characterCount: 100 });
    assert.deepEqual(metricSelections.at(-1), [4, 12, 15]);
    assert.deepEqual(toc.map((entry: { chapterId: string; sequenceNumber: number }) => [entry.chapterId, entry.sequenceNumber]), [
      ["paragraph-2", 2], ["paragraph-8", 8], ["paragraph-12", 12], ["paragraph-18", 18]
    ]);
    assert.deepEqual(readingMetrics.sections.map((section: Record<string, number | string>) => ({
      chapterId: section.chapterId,
      start: section.startSequenceNumber,
      end: section.endSequenceNumber,
      words: section.wordCount,
      characters: section.characterCount,
      wordsBefore: section.wordsBeforeSection,
      charactersBefore: section.charactersBeforeSection,
      startPage: section.startPageNumber,
      endPage: section.endPageNumber
    })), [
      { chapterId: "paragraph-2", start: 2, end: 8, words: 3, characters: 30, wordsBefore: 0, charactersBefore: 0, startPage: 4, endPage: 4 },
      { chapterId: "paragraph-8", start: 8, end: 12, words: 0, characters: 0, wordsBefore: 3, charactersBefore: 30, startPage: 8, endPage: 8 },
      { chapterId: "paragraph-12", start: 12, end: 18, words: 7, characters: 70, wordsBefore: 3, charactersBefore: 30, startPage: 12, endPage: 15 },
      { chapterId: "paragraph-18", start: 18, end: 19, words: 0, characters: 0, wordsBefore: 10, charactersBefore: 100, startPage: 18, endPage: 18 }
    ]);
    assert.equal(bookmarks[0].paragraphId, bookmark.paragraphId);
    assert.equal(bookmarks[0].sequenceNumber, 9);
    assert.deepEqual(paragraphs, visibleParagraphs);
    assert.equal(paragraphs.length, 10);
    assert.equal(paragraphs.reduce((sum, p) => sum + p.wordCount, 0), 420);
  });

  await t.test("fully muted book has zero metrics and still exposes all chapter entries", async () => {
    paragraphs = paragraphs.map((p) => ({ ...p, readAloud: 0 }));
    const response = await app.inject({ method: "GET", url: `/books/${bookId}/navigation` });
    assert.equal(response.statusCode, 200);
    const { readingMetrics, toc } = response.json();
    assert.deepEqual(readingMetrics.book, { wordCount: 0, characterCount: 0 });
    assert.deepEqual(metricSelections.at(-1), []);
    assert.equal(toc.length, 4);
    for (const section of readingMetrics.sections) {
      assert.equal(section.wordCount, 0);
      assert.equal(section.characterCount, 0);
      assert.equal(section.wordsBeforeSection, 0);
      assert.equal(section.charactersBeforeSection, 0);
      assert.equal(section.startPageNumber, section.startSequenceNumber);
      assert.equal(section.endPageNumber, section.startSequenceNumber);
      assert.ok(section.endSequenceNumber > section.startSequenceNumber);
    }
    assert.deepEqual(toc.map((entry: { chapterId: string }) => entry.chapterId), ["paragraph-2", "paragraph-8", "paragraph-12", "paragraph-18"]);
  });
});

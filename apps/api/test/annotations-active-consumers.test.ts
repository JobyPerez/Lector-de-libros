import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";
import oracledb from "oracledb";

import { closeConnectionPool, initializeConnectionPool } from "../src/config/database.js";
import { registerAnnotationRoutes } from "../src/modules/annotations/annotations.routes.js";

const bookId = "30000000-0000-4000-8000-000000000001";
const userId = "30000000-0000-4000-8000-000000000002";
const activeId = "30000000-0000-4000-8000-000000000003";
const inactiveId = "30000000-0000-4000-8000-000000000004";
const highlightId = "30000000-0000-4000-8000-000000000005";

test("annotation destinations default to active, with an authorized editorial opt-in", async (t) => {
  let role = "viewer";
  const paragraphs = [
    { paragraphId: activeId, isActive: 1, readAloud: 0, sequenceNumber: 3, wordCount: 5, characterCount: 50 },
    { paragraphId: inactiveId, isActive: 0, readAloud: 1, sequenceNumber: 7, wordCount: 100, characterCount: 1000 },
    { paragraphId: "body", isActive: 1, readAloud: 1, sequenceNumber: 11, wordCount: 2, characterCount: 20 }
  ].map((p) => ({ ...p, pageNumber: 1, paragraphNumber: p.sequenceNumber, paragraphText: "Paragraph text" }));
  const bookmarks = [activeId, inactiveId].map((paragraphId, index) => ({
    bookmarkId: `bookmark-${index}`, paragraphId, pageNumber: 1, paragraphNumber: index ? 7 : 3,
    sequenceNumber: index ? 7 : 3, userId, isDirectRecipient: 0
  }));
  const highlights = [activeId, inactiveId].map((paragraphId, index) => ({
    highlightId: index ? highlightId : "active-highlight", paragraphId, pageNumber: 1, paragraphNumber: index ? 7 : 3,
    sequenceNumber: index ? 7 : 3, userId, color: "YELLOW", charStart: 0, charEnd: 4, highlightedText: "Text"
  }));
  const notes = [
    { noteId: "active-note", paragraphId: activeId, highlightId: null },
    { noteId: "inactive-note", paragraphId: inactiveId, highlightId: null },
    { noteId: "page-note", paragraphId: null, highlightId: null },
    { noteId: "highlight-only-note", paragraphId: null, highlightId },
    { noteId: "mismatched-note", paragraphId: activeId, highlightId }
  ].map((n) => ({ ...n, pageNumber: 1, userId, sharedWithUserIds: "recipient" }));
  const isActive = (id: unknown) => paragraphs.some((p) => p.paragraphId === id && p.isActive === 1);
  const writes: Array<{ sql: string; binds: Record<string, any> }> = [];
  const connection = {
    async execute(sql: string, binds: Record<string, any> = {}) {
      if (sql.startsWith("ALTER SESSION")) return {};
      if (sql.includes("FROM books WHERE book_id = :bookId FOR UPDATE")) return { rows: [{ bookId }] };
      if (sql.includes('AS "shareRole"')) return { rows: [{ ownerUserId: role === "owner" ? userId : "other", shareRole: role, shareUserAnnotations: "N" }] };
      if (sql.includes("FROM user_bookmarks b")) {
        assert.match(sql, /:includeInactive = 1 OR EXISTS/);
        assert.match(sql, /bp\.book_id = b\.book_id/);
        assert.match(sql, /bp\.paragraph_id = b\.paragraph_id\s+AND bp\.is_active = 1/);
        assert.doesNotMatch(sql, /read_aloud/);
        return { rows: bookmarks.filter((b) => binds.includeInactive === 1 || isActive(b.paragraphId)) };
      }
      if (sql.includes('SELECT s.annotation_id AS "bookmarkId"')) return { rows: bookmarks.map((b) => ({ bookmarkId: b.bookmarkId, userId: "recipient" })) };
      if (sql.includes("FROM user_highlights h")) {
        assert.match(sql, /:includeInactive = 1 OR EXISTS/);
        assert.match(sql, /bp\.paragraph_id = h\.paragraph_id\s+AND bp\.is_active = 1/);
        assert.doesNotMatch(sql, /read_aloud/);
        return { rows: highlights.filter((h) => binds.includeInactive === 1 || isActive(h.paragraphId)) };
      }
      if (sql.includes("FROM user_notes n")) {
        assert.match(sql, /n\.paragraph_id IS NULL OR EXISTS/);
        assert.match(sql, /bp\.paragraph_id = n\.paragraph_id\s+AND bp\.is_active = 1/);
        assert.match(sql, /n\.highlight_id IS NULL OR EXISTS/);
        assert.match(sql, /bp\.paragraph_id = h\.paragraph_id\s+AND bp\.is_active = 1/);
        return { rows: notes.filter((n) => binds.includeInactive === 1 || (
          (n.paragraphId === null || isActive(n.paragraphId))
          && (n.highlightId === null || isActive(highlights.find((h) => h.highlightId === n.highlightId)?.paragraphId))
        )) };
      }
      if (sql.includes("FROM user_highlights")) {
        assert.match(sql, /bp\.paragraph_id = user_highlights\.paragraph_id\s+AND bp\.is_active = 1/);
        return { rows: highlights.filter((h) => h.highlightId === binds.highlightId && isActive(h.paragraphId)) };
      }
      if (sql.includes("FROM books b")) return { rows: [{ bookId, title: "Book", totalPages: 1, shareUserAnnotations: "N" }] };
      if (sql.includes("FROM book_pages")) return { rows: [{ pageNumber: 1, htmlContent: '<h1 data-paragraph-number="3">Muted active heading</h1><h1 data-paragraph-number="7">Inactive heading</h1>' }] };
      if (sql.includes("FROM book_paragraphs")) {
        if (binds.paragraphId) {
          assert.match(sql, /AND is_active = 1/);
          return { rows: paragraphs.filter((p) => p.paragraphId === binds.paragraphId && p.isActive === 1) };
        }
        if (sql.includes('AS "characterCount"')) {
          assert.match(sql, /AND is_active = 1\s+AND read_aloud = 1/);
          return { rows: paragraphs.filter((p) => p.isActive === 1 && p.readAloud === 1) };
        }
        return { rows: paragraphs.map((p) => ({ ...p, active: p.isActive })) };
      }
      if (sql.includes("INSERT INTO")) {
        writes.push({ sql, binds });
        return { rowsAffected: 1 };
      }
      assert.fail(`Unexpected SQL: ${sql}`);
    },
    async close() {}, async commit() {}, async rollback() {}
  };
  t.mock.method(oracledb, "createPool", async () => ({ getConnection: async () => connection, close: async () => {} }));
  await initializeConnectionPool();
  const app = Fastify();
  t.after(async () => { await app.close(); await closeConnectionPool(); });
  app.addHook("onRoute", (route) => {
    if (Array.isArray(route.preHandler)) route.preHandler[0] = async (request) => {
      request.currentUser = { userId } as NonNullable<typeof request.currentUser>;
    };
  });
  await app.register(registerAnnotationRoutes);

  await t.test("public GET and navigation suppress inactive destinations and retain muted and page-level notes", async () => {
    for (const endpoint of ["annotations?pageNumber=1", "navigation"]) {
      const response = await app.inject(`/books/${bookId}/${endpoint}`);
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepEqual(body.bookmarks.map((b: { paragraphId: string }) => b.paragraphId), [activeId]);
      assert.equal(body.bookmarks[0].sequenceNumber, 3);
      assert.equal(body.bookmarks[0].visibilitySource, "OWN");
      assert.deepEqual(body.bookmarks[0].sharedWithUserIds, ["recipient"]);
      assert.deepEqual(body.highlights.map((h: { paragraphId: string }) => h.paragraphId), [activeId]);
      assert.deepEqual(body.notes.map((n: { noteId: string }) => n.noteId), ["active-note", "page-note"]);
      assert.deepEqual(body.notes[0].sharedWithUserIds, ["recipient"]);
      if (endpoint === "navigation") {
        assert.deepEqual(body.readingMetrics.book, { wordCount: 2, characterCount: 20 });
        assert.deepEqual(body.toc.map((entry: { chapterId: string }) => entry.chapterId), [activeId]);
        assert.equal(body.readingMetrics.sections[0].startSequenceNumber, 3);
      }
    }
    assert.equal(paragraphs.length, 3);
    assert.deepEqual(paragraphs.map((p) => p.sequenceNumber), [3, 7, 11]);
  });

  await t.test("true requires EDITOR, false remains public, and editors opt in without expanding TOC or metrics", async () => {
    for (const requestedRole of ["viewer", "commenter", "editor", "owner"]) {
      role = requestedRole;
      for (const endpoint of ["annotations?pageNumber=1&", "navigation?"]) {
        const response = await app.inject(`/books/${bookId}/${endpoint}includeInactive=true`);
        const authorized = ["editor", "owner"].includes(role);
        assert.equal(response.statusCode, authorized ? 200 : 403);
        if (!authorized) {
          assert.match(response.json().message, /EDITOR/);
          continue;
        }
        const body = response.json();
        assert.equal(body.bookmarks.length, 2);
        assert.equal(body.highlights.length, 2);
        assert.equal(body.notes.length, 5);
        assert.equal(body.bookmarks[1].paragraphId, inactiveId);
        assert.equal(body.bookmarks[1].sequenceNumber, 7);
        if (endpoint.startsWith("navigation")) {
          assert.equal(body.toc.length, 1);
          assert.deepEqual(body.readingMetrics.book, { wordCount: 2, characterCount: 20 });
        }
      }
    }
    role = "viewer";
    const response = await app.inject(`/books/${bookId}/annotations?pageNumber=1&includeInactive=false`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().bookmarks.length, 1);
    const invalid = await app.inject(`/books/${bookId}/navigation?includeInactive=arbitrary`);
    assert.notEqual(invalid.statusCode, 200);
  });

  await t.test("new references to inactive paragraphs or highlights reject even for editors", async () => {
    role = "editor";
    const requests = [
      { endpoint: "bookmarks", payload: { paragraphId: inactiveId } },
      { endpoint: "highlights", payload: { paragraphId: inactiveId, color: "YELLOW", charStart: 0, charEnd: 4, highlightedText: "Text" } },
      { endpoint: "notes", payload: { paragraphId: inactiveId, noteText: "Note" } },
      { endpoint: "notes", payload: { highlightId, noteText: "Note" } },
      { endpoint: "notes", payload: { highlightId, paragraphId: activeId, noteText: "Bypass attempt" } }
    ];
    for (const { endpoint, payload } of requests) {
      const response = await app.inject({ method: "POST", url: `/books/${bookId}/${endpoint}`, payload });
      assert.equal(response.statusCode, 404);
    }
    assert.equal(writes.length, 0);
    const pageNote = await app.inject({ method: "POST", url: `/books/${bookId}/notes`, payload: { pageNumber: 1, noteText: "Page note" } });
    assert.equal(pageNote.statusCode, 201);
    assert.equal(pageNote.json().note.paragraphId, null);
    assert.equal(writes.length, 2);
    assert.equal(writes[0]!.binds.paragraphId, null);
  });
});

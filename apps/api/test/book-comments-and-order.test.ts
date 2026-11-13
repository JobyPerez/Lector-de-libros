import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import oracledb from "oracledb";

import { closeConnectionPool, initializeConnectionPool } from "../src/config/database.js";
import { registerBookCommentRoutes } from "../src/modules/annotations/book-comments.routes.js";
import { annotationOrderSchema, commentContentSchema } from "../src/modules/annotations/book-comments.schema.js";

test("comments require title or text, allow either or both, and reject whitespace-only values", () => {
  for (const value of [{ title: "Título" }, { commentText: "Texto" }, { title: "Título", commentText: "Texto" }]) {
    assert.equal(commentContentSchema.safeParse(value).success, true);
  }
  for (const value of [{}, { title: " \n", commentText: "\t " }, { title: "x".repeat(301) }, { commentText: "x".repeat(10001) }]) {
    assert.equal(commentContentSchema.safeParse(value).success, false);
  }
  assert.deepEqual(commentContentSchema.parse({ title: " Título " }), { title: "Título", commentText: "" });
  const key = `note:${randomUUID()}`;
  assert.equal(annotationOrderSchema.safeParse({ keys: [key, key] }).success, false);
  assert.equal(annotationOrderSchema.safeParse({ keys: ["toc:invalid"] }).success, false);
});

test("book comments enforce note-equivalent access/sharing and annotation ordering is personal", async (t) => {
  const bookId = randomUUID(), owner = randomUUID(), recipient = randomUUID(), outsider = randomUUID();
  const noteId = randomUUID(), highlightId = randomUUID();
  let currentUser = owner, shareAll = false, revokeOnLock = false, failOrderWrite = false;
  const roles = new Map([[owner, "owner"], [recipient, "commenter"]]);
  type Comment = { commentId: string; userId: string; bookId: string; title: string; commentText: string };
  let comments: Comment[] = [];
  let shares: Array<{ annotationId: string; annotationType: string; userId: string }> = [];
  let orders: Array<{ userId: string; bookId: string; key: string; position: number }> = [];
  let committed = { comments: structuredClone(comments), shares: structuredClone(shares), orders: structuredClone(orders) };
  const connection = {
    async execute(sql: string, binds: Record<string, any> = {}) {
      if (sql.startsWith("ALTER SESSION")) return {};
      if (sql.includes('AS "shareRole"')) return { rows: [{ ownerUserId: owner, shareRole: roles.get(binds.userId) ?? null, shareUserAnnotations: shareAll ? "Y" : "N" }] };
      if (sql.includes("FROM books WHERE book_id = :bookId FOR UPDATE")) {
        if (revokeOnLock) roles.delete(currentUser);
        return { rows: [{ bookId }] };
      }
      if (sql.includes('b.title AS "title"')) return { rows: roles.has(binds.userId) ? [{ bookId, title: "Book", shareUserAnnotations: shareAll ? "Y" : "N" }] : [] };
      if (sql.includes("FROM user_book_comments c JOIN users")) {
        assert.match(sql, /c\.user_id = :userId OR :shareAll = 1 OR EXISTS/);
        return { rows: comments.filter((c) => c.bookId === binds.bookId && (c.userId === binds.userId || binds.shareAll === 1 || shares.some((s) => s.annotationId === c.commentId && s.userId === binds.userId))).map((c) => ({
          ...c, username: "author", userDisplayName: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          isDirectRecipient: Number(shares.some((s) => s.annotationId === c.commentId && s.userId === binds.userId))
        })) };
      }
      if (sql.includes('s.annotation_id AS "commentId"')) return { rows: shares.filter((s) => comments.some((c) => c.commentId === s.annotationId && c.userId === binds.userId)).map((s) => ({ commentId: s.annotationId, userId: s.userId })) };
      if (sql.includes("INSERT INTO user_book_comments")) { comments.push({ ...binds } as Comment); return { rowsAffected: 1 }; }
      if (sql.includes("UPDATE user_book_comments")) {
        const comment = comments.find((c) => c.commentId === binds.commentId && c.bookId === binds.bookId && c.userId === binds.userId);
        if (comment) Object.assign(comment, { title: binds.title, commentText: binds.commentText });
        return { rowsAffected: Number(Boolean(comment)) };
      }
      if (sql.includes("SELECT comment_id FROM user_book_comments")) return { rows: comments.filter((c) => c.commentId === binds.commentId && c.bookId === binds.bookId && c.userId === binds.userId) };
      if (sql.includes("FROM users u") || sql.includes("accessible.user_id")) {
        const ids = Object.entries(binds).filter(([key]) => key.startsWith("u") || key.startsWith("recipient")).map(([, value]) => value);
        return { rows: ids.filter((id) => roles.has(id)).map((userId) => ({ userId })) };
      }
      if (sql.includes("DELETE FROM user_book_comments")) {
        const before = comments.length;
        comments = comments.filter((c) => !(c.commentId === binds.commentId && c.bookId === binds.bookId && c.userId === binds.userId));
        if (before !== comments.length) shares = shares.filter((s) => s.annotationId !== binds.commentId);
        return { rowsAffected: before - comments.length };
      }
      if (sql.includes("DELETE FROM annotation_shares")) {
        const before = shares.length;
        shares = shares.filter((s) => !(s.annotationId === binds.commentId && (!binds.userId || (s.userId === binds.userId && comments.some((c) => c.commentId === s.annotationId && c.bookId === binds.bookId)))));
        return { rowsAffected: before - shares.length };
      }
      if (sql.includes("FROM user_highlights h")) return { rows: [{ highlightId, userId: binds.userId }] };
      if (sql.includes("FROM user_notes n")) return { rows: [{ noteId, userId: owner, sharedWithUserIds: recipient }] };
      const matchesScope = (key: string) => sql.includes("entry_key LIKE 'comment:%'") ? key.startsWith("comment:") : !key.startsWith("comment:");
      if (sql.includes("DELETE FROM user_annotation_order")) { orders = orders.filter((row) => row.bookId !== binds.bookId || row.userId !== binds.userId || !matchesScope(row.key)); return {}; }
      if (sql.includes("FROM user_annotation_order")) return { rows: orders.filter((row) => row.bookId === binds.bookId && row.userId === binds.userId && matchesScope(row.key)).sort((a, b) => a.position - b.position) };
      assert.fail(`Unexpected SQL: ${sql}`);
    },
    async executeMany(sql: string, rows: any[]) {
      if (sql.includes("INSERT INTO annotation_shares")) shares.push(...rows);
      else if (sql.includes("INSERT INTO user_annotation_order")) {
        if (failOrderWrite) throw new Error("write failed");
        orders.push(...rows);
      } else assert.fail(sql);
    },
    async commit() { committed = structuredClone({ comments, shares, orders }); },
    async rollback() { ({ comments, shares, orders } = structuredClone(committed)); },
    async close() { await this.rollback(); }
  };
  t.mock.method(oracledb, "createPool", async () => ({ getConnection: async () => connection, close: async () => {} }));
  await initializeConnectionPool();
  const app = Fastify();
  app.addHook("onRoute", (route) => {
    if (Array.isArray(route.preHandler)) route.preHandler[0] = async (request) => { request.currentUser = { userId: currentUser } as NonNullable<typeof request.currentUser>; };
  });
  app.setErrorHandler((error: any, _request, reply) => { reply.status(error.statusCode ?? 500).send({ message: error.message }); });
  await app.register(registerBookCommentRoutes);
  t.after(async () => { await app.close(); await closeConnectionPool(); });
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", suffix: string, payload?: any) => app.inject({ method, url: `/books/${bookId}/${suffix}`, ...(payload === undefined ? {} : { payload }) });
  let id = "";

  await t.test("create/update accept title only, text only or both and reject empty content", async () => {
    for (const payload of [{ title: " Título " }, { commentText: "Texto" }, { title: "Ambos", commentText: "Texto" }]) {
      const created = await call("POST", "comments", payload);
      assert.equal(created.statusCode, 201, created.body);
      id = created.json().commentId;
    }
    assert.equal(comments.length, 3);
    for (const payload of [{}, { title: " ", commentText: "\n" }]) {
      assert.equal((await call("POST", "comments", payload)).statusCode, 422);
      assert.equal((await call("PUT", `comments/${id}`, payload)).statusCode, 422);
    }
    assert.equal((await call("PUT", `comments/${id}`, { title: "Solo título" })).statusCode, 204);
    assert.equal(comments.at(-1)?.commentText, null);
  });
  await t.test("only author edits/shares; recipients must have book access; invalid changes are atomic", async () => {
    assert.equal((await call("PUT", `comments/${id}/shares`, { sharedWithUserIds: [recipient, recipient, owner] })).statusCode, 204);
    assert.equal(shares.length, 1);
    assert.equal((await call("PUT", `comments/${id}/shares`, { sharedWithUserIds: [outsider] })).statusCode, 422);
    assert.equal(shares.length, 1, "invalid recipients must not clear existing shares");
    currentUser = recipient;
    assert.equal((await call("GET", "comments")).json().comments.length, 1);
    const received = (await call("GET", "comments")).json().comments[0];
    assert.equal(received.isOwnedByCurrentUser, false);
    assert.equal(received.visibilitySource, "DIRECT");
    assert.deepEqual(received.sharedWithUserIds, []);
    assert.equal((await call("PUT", `comments/${id}`, { title: "No permitido" })).statusCode, 404);
    assert.equal((await call("PUT", `comments/${id}/shares`, { sharedWithUserIds: [] })).statusCode, 404);
    assert.equal((await call("DELETE", `comments/${id}`)).statusCode, 204);
    assert.equal(comments.length, 3, "recipient removal must not delete the original");
    assert.equal((await call("GET", "comments")).json().comments.length, 0);
    shareAll = true;
    const visible = (await call("GET", "comments")).json().comments;
    assert.equal(visible.length, 3);
    assert.ok(visible.every((comment: any) => comment.visibilitySource === "BOOK"));
    shareAll = false;
  });
  await t.test("viewer cannot create/edit/share, and revoked access is rechecked after the write lock", async () => {
    roles.set(recipient, "viewer");
    assert.equal((await call("GET", "comments")).json().canComment, false);
    assert.equal((await call("POST", "comments", { title: "No" })).statusCode, 403);
    assert.equal((await call("PUT", `comments/${id}`, { title: "No" })).statusCode, 403);
    assert.equal((await call("PUT", `comments/${id}/shares`, { sharedWithUserIds: [] })).statusCode, 403);
    roles.set(recipient, "commenter");
    revokeOnLock = true;
    assert.equal((await call("POST", "comments", { title: "No" })).statusCode, 404);
    assert.equal(comments.length, 3);
    revokeOnLock = false;
    assert.equal((await call("GET", "comments")).statusCode, 404);
    roles.set(recipient, "commenter");
  });
  await t.test("note/highlight ordering persists per user and rejects missing or duplicate entries without losing the old order", async () => {
    const keys = [`highlight:${highlightId}`, `note:${noteId}`];
    currentUser = owner;
    assert.equal((await call("PUT", "annotation-order", { keys })).statusCode, 204);
    assert.deepEqual((await call("GET", "annotation-order")).json().keys, keys);
    currentUser = recipient;
    assert.deepEqual((await call("GET", "annotation-order")).json().keys, []);
    assert.equal((await call("PUT", "annotation-order", { keys: [...keys].reverse() })).statusCode, 204);
    currentUser = owner;
    for (const invalid of [[keys[0], keys[0]], [`note:${randomUUID()}`]]) {
      assert.equal((await call("PUT", "annotation-order", { keys: invalid })).statusCode, 422);
      assert.deepEqual((await call("GET", "annotation-order")).json().keys, keys);
    }
    failOrderWrite = true;
    assert.equal((await call("PUT", "annotation-order", { keys: [...keys].reverse() })).statusCode, 500);
    failOrderWrite = false;
    assert.deepEqual((await call("GET", "annotation-order")).json().keys, keys);
  });
  await t.test("comment order is independent of notes and other users and only accepts visible comments", async () => {
    currentUser = owner;
    const noteKeys = (await call("GET", "annotation-order")).json().keys;
    const keys = comments.map((comment) => `comment:${comment.commentId}`).reverse();
    const endpoint = "annotation-order?scope=comments";
    assert.equal((await call("PUT", endpoint, { keys })).statusCode, 204);
    assert.deepEqual((await call("GET", endpoint)).json().keys, keys);
    assert.deepEqual((await call("GET", "annotation-order")).json().keys, noteKeys);
    assert.equal((await call("PUT", "annotation-order", { keys })).statusCode, 422);
    assert.equal((await call("PUT", endpoint, { keys: noteKeys })).statusCode, 422);
    currentUser = recipient;
    assert.deepEqual((await call("GET", endpoint)).json().keys, []);
    assert.equal((await call("PUT", endpoint, { keys })).statusCode, 422, "private comments cannot be ordered by a different user");
    roles.set(recipient, "viewer");
    shareAll = true;
    assert.equal((await call("PUT", endpoint, { keys: [...keys].reverse() })).statusCode, 204, "viewers can personally order comments shared with them");
    shareAll = false;
    roles.set(recipient, "commenter");
    currentUser = owner;
    assert.deepEqual((await call("GET", endpoint)).json().keys, keys);
    assert.equal((await call("PUT", "annotation-order", { keys: [] })).statusCode, 204);
    assert.deepEqual((await call("GET", endpoint)).json().keys, keys, "resetting notes must not reset comments");
    assert.equal((await call("GET", "annotation-order?scope=invalid")).statusCode, 422);
  });
  await t.test("author deletion removes original and its shares", async () => {
    assert.equal((await call("PUT", `comments/${id}/shares`, { sharedWithUserIds: [recipient] })).statusCode, 204);
    assert.equal((await call("DELETE", `comments/${id}`)).statusCode, 204);
    assert.equal(comments.length, 2);
    assert.equal(shares.length, 0);
  });
});

test("legacy comments migrate atomically without truncation, titles, new shares or repeat copies", () => {
  const sql = readFileSync(new URL("../sql/042_book_comments_and_annotation_order.sql", import.meta.url), "utf8");
  assert.match(sql, /WHERE user_comments IS NOT NULL AND DBMS_LOB.GETLENGTH\(user_comments\) > 0\s+FOR UPDATE/);
  assert.match(sql, /settings.user_id, settings.book_id, settings.user_comments, settings.created_at, settings.updated_at/);
  assert.match(sql, /UPDATE user_book_settings SET user_comments = NULL/);
  assert.match(sql, /COMMIT;\s+EXCEPTION WHEN OTHERS THEN\s+ROLLBACK;/);
  assert.doesNotMatch(sql, /INSERT INTO annotation_shares/);
});

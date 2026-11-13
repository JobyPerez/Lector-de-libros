import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { assertBookRole, requireBookRole } from "../../services/book-access.js";
import { authenticateRequest } from "../auth/auth.routes.js";
import { findAccessibleBook, insertAnnotationShares, listHighlightsShared, listNotesShared, validateAnnotationShareRecipients } from "./annotations.routes.js";
import { annotationOrderQuerySchema, annotationOrderSchema, commentContentSchema } from "./book-comments.schema.js";

const bookParamsSchema = z.object({ bookId: z.string().uuid() });
const commentParamsSchema = bookParamsSchema.extend({ commentId: z.string().uuid() });
const recipientsSchema = z.object({ sharedWithUserIds: z.array(z.string().uuid()).max(200) });
type CommentRow = {
  commentId: string;
  title: string | null;
  commentText: string | null;
  userId: string;
  username: string;
  userDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
  isDirectRecipient: number;
};

async function listVisibleComments(connection: Awaited<ReturnType<typeof getConnection>>, bookId: string, userId: string, shareAll: boolean): Promise<CommentRow[]> {
  const result = await connection.execute(`
    SELECT c.comment_id AS "commentId", c.title AS "title", c.comment_text AS "commentText",
           c.user_id AS "userId", u.username AS "username", u.display_name AS "userDisplayName",
           c.created_at AS "createdAt", c.updated_at AS "updatedAt",
           CASE WHEN EXISTS (
             SELECT 1 FROM annotation_shares s WHERE s.annotation_id = c.comment_id
               AND s.annotation_type = 'comment' AND s.user_id = :userId
           ) THEN 1 ELSE 0 END AS "isDirectRecipient"
    FROM user_book_comments c JOIN users u ON u.user_id = c.user_id
    WHERE c.book_id = :bookId AND (
      c.user_id = :userId OR :shareAll = 1 OR EXISTS (
        SELECT 1 FROM annotation_shares s WHERE s.annotation_id = c.comment_id
          AND s.annotation_type = 'comment' AND s.user_id = :userId
      )
    )
    ORDER BY c.created_at DESC, c.comment_id
  `, { bookId, userId, shareAll: shareAll ? 1 : 0 });
  return result.rows ?? [];
}

function orderScopeFilter(scope: "notes" | "comments") {
  return scope === "comments" ? "entry_key LIKE 'comment:%'" : "entry_key NOT LIKE 'comment:%'";
}

export const registerBookCommentRoutes: FastifyPluginAsync = async (app) => {
  const viewer = [authenticateRequest, requireBookRole("VIEWER")];
  const commenter = [authenticateRequest, requireBookRole("COMMENTER")];

  app.get("/books/:bookId/comments", { preHandler: viewer }, async (request, reply) => {
    const { bookId } = bookParamsSchema.parse(request.params);
    const userId = request.currentUser!.userId;
    const connection = await getConnection();
    try {
      const book = await findAccessibleBook(connection, bookId, userId);
      if (!book) return reply.status(404).send({ message: "Book not found." });
      const comments = await listVisibleComments(connection, bookId, userId, book.shareUserAnnotations);
      const shares = await connection.execute(`
        SELECT s.annotation_id AS "commentId", s.user_id AS "userId"
        FROM annotation_shares s JOIN user_book_comments c ON c.comment_id = s.annotation_id
        WHERE s.annotation_type = 'comment' AND c.book_id = :bookId AND c.user_id = :userId
      `, { bookId, userId });
      const recipients = new Map<string, string[]>();
      for (const share of (shares.rows ?? []) as Array<{ commentId: string; userId: string }>) {
        recipients.set(share.commentId, [...(recipients.get(share.commentId) ?? []), share.userId]);
      }
      return { canComment: request.bookAccess?.role !== "VIEWER", comments: comments.map(({ isDirectRecipient, ...row }) => ({
        ...row,
        title: row.title ?? "",
        commentText: row.commentText ?? "",
        isOwnedByCurrentUser: row.userId === userId,
        sharedWithUserIds: row.userId === userId ? recipients.get(row.commentId) ?? [] : [],
        visibilitySource: row.userId === userId ? "OWN" : isDirectRecipient ? "DIRECT" : "BOOK"
      })) };
    } finally { await connection.close(); }
  });

  app.post("/books/:bookId/comments", { preHandler: commenter }, async (request, reply) => {
    const { bookId } = bookParamsSchema.parse(request.params);
    const parsed = commentContentSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(422).send({ message: parsed.error.issues[0]?.message });
    const userId = request.currentUser!.userId;
    const commentId = randomUUID();
    const connection = await getConnection();
    try {
      await connection.execute("SELECT book_id FROM books WHERE book_id = :bookId FOR UPDATE", { bookId });
      await assertBookRole(connection, bookId, userId, "COMMENTER");
      await connection.execute(`
        INSERT INTO user_book_comments (comment_id, user_id, book_id, title, comment_text)
        VALUES (:commentId, :userId, :bookId, :title, :commentText)
      `, { commentId, userId, bookId, title: parsed.data.title || null, commentText: parsed.data.commentText || null });
      await connection.commit();
      return reply.status(201).send({ commentId });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { await connection.close(); }
  });

  app.put("/books/:bookId/comments/:commentId", { preHandler: commenter }, async (request, reply) => {
    const { bookId, commentId } = commentParamsSchema.parse(request.params);
    const parsed = commentContentSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(422).send({ message: parsed.error.issues[0]?.message });
    const connection = await getConnection();
    try {
      await connection.execute("SELECT book_id FROM books WHERE book_id = :bookId FOR UPDATE", { bookId });
      await assertBookRole(connection, bookId, request.currentUser!.userId, "COMMENTER");
      const result = await connection.execute(`
        UPDATE user_book_comments SET title = :title, comment_text = :commentText, updated_at = SYSTIMESTAMP
        WHERE comment_id = :commentId AND book_id = :bookId AND user_id = :userId
      `, { bookId, commentId, userId: request.currentUser!.userId, title: parsed.data.title || null, commentText: parsed.data.commentText || null });
      if (!result.rowsAffected) return reply.status(404).send({ message: "Comentario no encontrado." });
      await connection.commit();
      return reply.status(204).send();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { await connection.close(); }
  });

  app.put("/books/:bookId/comments/:commentId/shares", { preHandler: commenter }, async (request, reply) => {
    const { bookId, commentId } = commentParamsSchema.parse(request.params);
    const parsed = recipientsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(422).send({ message: "Los destinatarios no son válidos." });
    const { sharedWithUserIds } = parsed.data;
    const userId = request.currentUser!.userId;
    const connection = await getConnection();
    try {
      await connection.execute("SELECT book_id FROM books WHERE book_id = :bookId FOR UPDATE", { bookId });
      await assertBookRole(connection, bookId, userId, "COMMENTER");
      const owned = await connection.execute(`
        SELECT comment_id FROM user_book_comments
        WHERE comment_id = :commentId AND book_id = :bookId AND user_id = :userId FOR UPDATE
      `, { bookId, commentId, userId });
      if (!owned.rows?.length) return reply.status(404).send({ message: "Comentario no encontrado." });
      const recipients = await validateAnnotationShareRecipients(connection, bookId, userId, sharedWithUserIds);
      await connection.execute("DELETE FROM annotation_shares WHERE annotation_id = :commentId AND annotation_type = 'comment'", { commentId });
      await insertAnnotationShares(connection, commentId, "comment", bookId, recipients);
      await connection.commit();
      return reply.status(204).send();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { await connection.close(); }
  });

  app.delete("/books/:bookId/comments/:commentId", { preHandler: viewer }, async (request, reply) => {
    const { bookId, commentId } = commentParamsSchema.parse(request.params);
    const userId = request.currentUser!.userId;
    const connection = await getConnection();
    try {
      await connection.execute("SELECT book_id FROM books WHERE book_id = :bookId FOR UPDATE", { bookId });
      await assertBookRole(connection, bookId, userId, "VIEWER");
      const deleted = await connection.execute(`
        DELETE FROM user_book_comments WHERE comment_id = :commentId AND book_id = :bookId AND user_id = :userId
      `, { bookId, commentId, userId });
      if (!deleted.rowsAffected) {
        const removed = await connection.execute(`
          DELETE FROM annotation_shares s WHERE s.annotation_id = :commentId AND s.annotation_type = 'comment'
            AND s.user_id = :userId AND EXISTS (
              SELECT 1 FROM user_book_comments c WHERE c.comment_id = s.annotation_id AND c.book_id = :bookId
            )
        `, { bookId, commentId, userId });
        if (!removed.rowsAffected) return reply.status(404).send({ message: "Comentario no encontrado." });
      }
      await connection.commit();
      return reply.status(204).send();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { await connection.close(); }
  });

  app.get("/books/:bookId/annotation-order", { preHandler: viewer }, async (request, reply) => {
    const { bookId } = bookParamsSchema.parse(request.params);
    const query = annotationOrderQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(422).send({ message: "El tipo de orden no es válido." });
    const connection = await getConnection();
    try {
      const result = await connection.execute(`
        SELECT entry_key AS "key" FROM user_annotation_order
        WHERE book_id = :bookId AND user_id = :userId AND ${orderScopeFilter(query.data.scope)} ORDER BY position
      `, { bookId, userId: request.currentUser!.userId });
      return { keys: ((result.rows ?? []) as Array<{ key: string }>).map((row) => row.key) };
    } finally { await connection.close(); }
  });

  app.put("/books/:bookId/annotation-order", { preHandler: viewer }, async (request, reply) => {
    const { bookId } = bookParamsSchema.parse(request.params);
    const parsed = annotationOrderSchema.safeParse(request.body);
    const query = annotationOrderQuerySchema.safeParse(request.query);
    if (!parsed.success || !query.success) return reply.status(422).send({ message: "El orden no es válido." });
    const userId = request.currentUser!.userId;
    const connection = await getConnection();
    try {
      // Serialize concurrent saves and book edits, without modifying anyone else's order.
      await connection.execute("SELECT book_id FROM books WHERE book_id = :bookId FOR UPDATE", { bookId });
      await assertBookRole(connection, bookId, userId, "VIEWER");
      const book = await findAccessibleBook(connection, bookId, userId);
      if (!book) return reply.status(404).send({ message: "Book not found." });
      let allowed: Set<string>;
      if (query.data.scope === "comments") {
        const comments = await listVisibleComments(connection, bookId, userId, book.shareUserAnnotations);
        allowed = new Set(comments.map((comment) => `comment:${comment.commentId}`));
      } else {
        const notes = await listNotesShared(connection, userId, bookId, undefined, book.shareUserAnnotations, true);
        const highlights = await listHighlightsShared(connection, userId, bookId, undefined, book.shareUserAnnotations, true);
        allowed = new Set([...notes.map((note) => `note:${note.noteId}`), ...highlights.map((highlight) => `highlight:${highlight.highlightId}`)]);
      }
      if (parsed.data.keys.some((key) => !allowed.has(key))) {
        return reply.status(422).send({ message: "Algún elemento ya no está disponible. Actualiza el panel." });
      }
      await connection.execute(`DELETE FROM user_annotation_order WHERE book_id = :bookId AND user_id = :userId AND ${orderScopeFilter(query.data.scope)}`, { bookId, userId });
      if (parsed.data.keys.length) {
        await connection.executeMany(`
          INSERT INTO user_annotation_order (user_id, book_id, entry_key, position) VALUES (:userId, :bookId, :key, :position)
        `, parsed.data.keys.map((key, position) => ({ userId, bookId, key, position })));
      }
      await connection.commit();
      return reply.status(204).send();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { await connection.close(); }
  });
};

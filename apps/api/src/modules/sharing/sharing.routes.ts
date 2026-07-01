import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { authenticateRequest } from "../auth/auth.routes.js";
import {
  logShareEvent,
  requireBookRole
} from "../../services/book-access.js";

const SHARE_ROLES = ["viewer", "commenter", "editor"] as const;
type ShareRole = (typeof SHARE_ROLES)[number];

const addShareSchema = z.object({
  role: z.enum(SHARE_ROLES),
  userId: z.string().uuid()
});

const updateShareSchema = z.object({
  role: z.enum(SHARE_ROLES)
});

const transferSchema = z.object({
  username: z.string().trim().min(3).max(50)
});

const shareUserAnnotationsSchema = z.object({
  enabled: z.boolean()
});

type ShareRow = {
  role: ShareRole;
  shareCreatedAt: Date;
  userDisplayName: string | null;
  userEmail: string;
  userId: string;
  userUsername: string;
  invitedByUsername: string | null;
};

export const registerSharingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", authenticateRequest);

  const ownerOnly = requireBookRole("OWNER");
  const viewerOrAbove = requireBookRole("VIEWER");

  app.get("/:bookId/shares", { preHandler: ownerOnly }, async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const connection = await getConnection();
    try {
      const result = await connection.execute(
        `SELECT s.user_id          AS "userId",
                LOWER(s.role)      AS "role",
                s.created_at       AS "shareCreatedAt",
                u.username         AS "userUsername",
                u.email            AS "userEmail",
                u.display_name     AS "userDisplayName",
                inviter.username   AS "invitedByUsername"
           FROM book_shares s
           JOIN users u ON u.user_id = s.user_id
           LEFT JOIN users inviter ON inviter.user_id = s.invited_by
          WHERE s.book_id = :bookId
          ORDER BY u.username ASC`,
        { bookId }
      );

      const shares = (result.rows ?? []) as ShareRow[];
      return {
        shares: shares.map((row) => ({
          createdAt: row.shareCreatedAt instanceof Date
            ? row.shareCreatedAt.toISOString()
            : String(row.shareCreatedAt),
          displayName: row.userDisplayName,
          email: row.userEmail,
          invitedByUsername: row.invitedByUsername,
          role: row.role,
          userId: row.userId,
          username: row.userUsername
        }))
      };
    } finally {
      await connection.close();
    }
  });

  app.get("/:bookId/sharable-users", { preHandler: ownerOnly }, async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const connection = await getConnection();
    try {
      const result = await connection.execute(
        `SELECT u.user_id    AS "userId",
                u.username   AS "username",
                u.display_name AS "displayName",
                u.email      AS "email",
                LOWER(s.role) AS "shareRole"
           FROM users u
           LEFT JOIN book_shares s
             ON s.book_id = :bookId
            AND s.user_id = u.user_id
          WHERE u.user_id <> :currentUserId
            AND NOT EXISTS (
              SELECT 1 FROM books b
               WHERE b.book_id = :bookId
                 AND b.owner_user_id = u.user_id
            )
          ORDER BY u.username ASC`,
        { bookId, currentUserId: request.currentUser!.userId }
      );

      const users = (result.rows ?? []) as Array<{
        userId: string;
        username: string;
        displayName: string | null;
        email: string;
        shareRole: ShareRole | null;
      }>;

      return reply.send({
        users: users.map((row) => ({
          displayName: row.displayName,
          email: row.email,
          role: row.shareRole,
          userId: row.userId,
          username: row.username
        }))
      });
    } finally {
      await connection.close();
    }
  });

  app.post("/:bookId/shares", { preHandler: ownerOnly }, async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const body = addShareSchema.parse(request.body);

    const connection = await getConnection();
    try {
      const ownerResult = await connection.execute(
        `SELECT owner_user_id AS "ownerUserId"
           FROM books
          WHERE book_id = :bookId`,
        { bookId }
      );
      const owner = (ownerResult.rows ?? [])[0] as { ownerUserId: string } | undefined;
      if (!owner) {
        await reply.status(404).send({ message: "Libro no encontrado." });
        return;
      }
      if (owner.ownerUserId === body.userId) {
        await reply.status(400).send({ message: "El propietario ya tiene acceso completo." });
        return;
      }

      const userResult = await connection.execute(
        `SELECT user_id  AS "userId",
                username AS "username"
           FROM users
          WHERE user_id = :userId`,
        { userId: body.userId }
      );
      const target = (userResult.rows ?? [])[0] as { userId: string; username: string } | undefined;
      if (!target) {
        await reply.status(404).send({ message: "Usuario no encontrado." });
        return;
      }

      await connection.execute(
        `MERGE INTO book_shares s
           USING (SELECT :bookId AS book_id, :userId AS user_id FROM DUAL) src
              ON (s.book_id = src.book_id AND s.user_id = src.user_id)
           WHEN MATCHED THEN
              UPDATE SET role = :role,
                         invited_by = :invitedBy
           WHEN NOT MATCHED THEN
              INSERT (book_id, user_id, role, invited_by)
              VALUES (:bookId, :userId, :role, :invitedBy)`,
        {
          bookId,
          invitedBy: request.currentUser!.userId,
          role: body.role,
          userId: target.userId
        },
        { autoCommit: true }
      );

      await logShareEvent({
        action: "share_added",
        actorUserId: request.currentUser!.userId,
        bookId,
        details: `role=${body.role}`,
        targetUserId: target.userId
      });

      return {
        role: body.role,
        userId: target.userId,
        username: target.username
      };
    } finally {
      await connection.close();
    }
  });

  app.put("/:bookId/shares/:userId", { preHandler: ownerOnly }, async (request, reply) => {
    const { bookId, userId } = request.params as { bookId: string; userId: string };
    const body = updateShareSchema.parse(request.body);

    const connection = await getConnection();
    try {
      const result = await connection.execute(
        `UPDATE book_shares
            SET role = :role
          WHERE book_id = :bookId
            AND user_id = :userId`,
        { bookId, role: body.role, userId },
        { autoCommit: true }
      );

      if ((result.rowsAffected ?? 0) === 0) {
        await reply.status(404).send({ message: "Compartición no encontrada." });
        return;
      }

      await logShareEvent({
        action: "share_role_changed",
        actorUserId: request.currentUser!.userId,
        bookId,
        details: `role=${body.role}`,
        targetUserId: userId
      });

      return { ok: true, role: body.role };
    } finally {
      await connection.close();
    }
  });

  app.delete("/:bookId/shares/:userId", { preHandler: ownerOnly }, async (request, reply) => {
    const { bookId, userId } = request.params as { bookId: string; userId: string };

    const connection = await getConnection();
    try {
      const result = await connection.execute(
        `DELETE FROM book_shares
          WHERE book_id = :bookId
            AND user_id = :userId`,
        { bookId, userId },
        { autoCommit: true }
      );

      if ((result.rowsAffected ?? 0) === 0) {
        await reply.status(404).send({ message: "Compartición no encontrada." });
        return;
      }

      await logShareEvent({
        action: "share_removed",
        actorUserId: request.currentUser!.userId,
        bookId,
        targetUserId: userId
      });

      return { ok: true };
    } finally {
      await connection.close();
    }
  });

  app.post("/:bookId/shares/leave", { preHandler: viewerOrAbove }, async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const access = request.bookAccess!;
    if (access.role === "OWNER") {
      await reply.status(400).send({ message: "El propietario no puede salir del libro. Transfiere la propiedad primero." });
      return;
    }

    const connection = await getConnection();
    try {
      const result = await connection.execute(
        `DELETE FROM book_shares
          WHERE book_id = :bookId
            AND user_id = :userId`,
        { bookId, userId: request.currentUser!.userId },
        { autoCommit: true }
      );

      if ((result.rowsAffected ?? 0) === 0) {
        await reply.status(404).send({ message: "No tienes acceso a este libro." });
        return;
      }

      await logShareEvent({
        action: "share_left",
        actorUserId: request.currentUser!.userId,
        bookId
      });

      return { ok: true };
    } finally {
      await connection.close();
    }
  });

  app.post("/:bookId/transfer", { preHandler: ownerOnly }, async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const body = transferSchema.parse(request.body);
    const normalizedUsername = body.username.toLowerCase();

    const connection = await getConnection();
    try {
      const userResult = await connection.execute(
        `SELECT user_id AS "userId"
           FROM users
          WHERE LOWER(username) = :username`,
        { username: normalizedUsername }
      );
      const target = (userResult.rows ?? [])[0] as { userId: string } | undefined;
      if (!target) {
        await reply.status(404).send({ message: "Usuario no encontrado." });
        return;
      }

      const currentOwnerResult = await connection.execute(
        `SELECT owner_user_id AS "ownerUserId"
           FROM books
          WHERE book_id = :bookId`,
        { bookId }
      );
      const current = (currentOwnerResult.rows ?? [])[0] as { ownerUserId: string } | undefined;
      if (!current) {
        await reply.status(404).send({ message: "Libro no encontrado." });
        return;
      }
      if (current.ownerUserId === target.userId) {
        await reply.status(400).send({ message: "El usuario ya es el propietario." });
        return;
      }

      await connection.execute(
        `UPDATE books
            SET owner_user_id = :newOwner
          WHERE book_id = :bookId`,
        { bookId, newOwner: target.userId },
        { autoCommit: true }
      );

      await connection.execute(
        `MERGE INTO book_shares s
           USING (SELECT :bookId AS book_id, :userId AS user_id FROM DUAL) src
              ON (s.book_id = src.book_id AND s.user_id = src.user_id)
           WHEN MATCHED THEN
              UPDATE SET role = 'editor'
           WHEN NOT MATCHED THEN
              INSERT (book_id, user_id, role, invited_by)
              VALUES (:bookId, :userId, 'editor', :invitedBy)`,
        { bookId, invitedBy: request.currentUser!.userId, userId: current.ownerUserId },
        { autoCommit: true }
      );

      await connection.execute(
        `DELETE FROM book_shares
          WHERE book_id = :bookId
            AND user_id = :userId`,
        { bookId, userId: target.userId },
        { autoCommit: true }
      );

      await logShareEvent({
        action: "ownership_transferred",
        actorUserId: request.currentUser!.userId,
        bookId,
        details: `from=${request.currentUser!.userId};to=${target.userId}`,
        targetUserId: target.userId
      });

      return { ok: true, newOwnerUserId: target.userId };
    } finally {
      await connection.close();
    }
  });

  app.put("/:bookId/share-user-annotations", { preHandler: ownerOnly }, async (request, reply) => {
    const { bookId } = request.params as { bookId: string };
    const body = shareUserAnnotationsSchema.parse(request.body);

    const connection = await getConnection();
    try {
      const result = await connection.execute(
        `UPDATE books
            SET share_user_annotations = :flag
          WHERE book_id = :bookId`,
        { bookId, flag: body.enabled ? "Y" : "N" },
        { autoCommit: true }
      );
      if ((result.rowsAffected ?? 0) === 0) {
        await reply.status(404).send({ message: "Libro no encontrado." });
        return;
      }

      await logShareEvent({
        action: "share_user_annotations_toggled",
        actorUserId: request.currentUser!.userId,
        bookId,
        details: `enabled=${body.enabled ? "Y" : "N"}`
      });

      return { shareUserAnnotations: body.enabled };
    } finally {
      await connection.close();
    }
  });
};

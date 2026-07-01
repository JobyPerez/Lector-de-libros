import type { FastifyReply, FastifyRequest } from "fastify";

import { getConnection } from "../config/database.js";

export type BookRole = "OWNER" | "EDITOR" | "COMMENTER" | "VIEWER";

export type BookAccess = {
  bookId: string;
  ownerUserId: string;
  shareUserAnnotations: boolean;
  role: BookRole;
};

const ROLE_RANK: Record<BookRole, number> = {
  OWNER: 3,
  EDITOR: 2,
  COMMENTER: 1,
  VIEWER: 0
};

export function roleAtLeast(role: BookRole, min: BookRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

function rowToRole(row: { owner_user_id: string; share_role: string | null }): BookRole {
  if (row.share_role === "editor") return "EDITOR";
  if (row.share_role === "commenter") return "COMMENTER";
  if (row.share_role === "viewer") return "VIEWER";
  return "OWNER";
}

export async function resolveBookAccess(
  bookId: string,
  userId: string
): Promise<BookAccess | null> {
  const connection = await getConnection();
  try {
    const result = await connection.execute(
      `SELECT b.owner_user_id      AS "ownerUserId",
              b.share_user_annotations AS "shareUserAnnotations",
              s.role              AS "shareRole"
         FROM books b
         LEFT JOIN book_shares s
           ON s.book_id = b.book_id
          AND s.user_id = :userId
        WHERE b.book_id = :bookId`,
      { bookId, userId }
    );

    const row = (result.rows ?? [])[0] as
      | { ownerUserId: string; shareRole: string | null; shareUserAnnotations: string }
      | undefined;
    if (!row) {
      return null;
    }

    if (row.ownerUserId === userId) {
      return {
        bookId,
        ownerUserId: row.ownerUserId,
        shareUserAnnotations: row.shareUserAnnotations === "Y",
        role: "OWNER"
      };
    }

    if (!row.shareRole) {
      return null;
    }

    return {
      bookId,
      ownerUserId: row.ownerUserId,
      shareUserAnnotations: row.shareUserAnnotations === "Y",
      role: rowToRole({ owner_user_id: row.ownerUserId, share_role: row.shareRole })
    };
  } finally {
    await connection.close();
  }
}

export async function logShareEvent(input: {
  bookId: string;
  actorUserId?: string | null;
  targetUserId?: string | null;
  action: string;
  details?: string | null;
}): Promise<void> {
  const connection = await getConnection();
  try {
    await connection.execute(
      `INSERT INTO book_share_audit_log
         (book_id, actor_user_id, target_user_id, action, details)
       VALUES
         (:bookId, :actorUserId, :targetUserId, :action, :details)`,
      {
        action: input.action,
        actorUserId: input.actorUserId ?? null,
        bookId: input.bookId,
        details: input.details ?? null,
        targetUserId: input.targetUserId ?? null
      },
      { autoCommit: true }
    );
  } finally {
    await connection.close();
  }
}

declare module "fastify" {
  interface FastifyRequest {
    bookAccess?: BookAccess;
  }
}

export function requireBookRole(minRole: BookRole) {
  return async function resolve(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.currentUser) {
      await reply.status(401).send({ message: "Unauthenticated request." });
      return;
    }

    const params = (request.params ?? {}) as { bookId?: string };
    const bookId = params.bookId;

    if (!bookId) {
      await reply.status(400).send({ message: "Missing bookId parameter." });
      return;
    }

    const access = await resolveBookAccess(bookId, request.currentUser.userId);
    if (!access) {
      await reply.status(404).send({ message: "Libro no encontrado." });
      return;
    }

    if (!roleAtLeast(access.role, minRole)) {
      await reply.status(403).send({
        message: `Esta acción requiere rol ${minRole} o superior.`
      });
      return;
    }

    request.bookAccess = access;
  };
}

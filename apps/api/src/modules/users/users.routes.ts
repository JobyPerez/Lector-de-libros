import { randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { authenticateRequest, requireAdministrator } from "../auth/auth.routes.js";

const userRoleSchema = z.enum(["ADMIN", "EDITOR"]);

const createUserSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  email: z.string().email(),
  password: z.string().min(8).max(72),
  role: userRoleSchema,
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_.-]+$/)
});

const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  email: z.string().email(),
  password: z.string().min(8).max(72).optional(),
  role: userRoleSchema
});

type ManagedUser = {
  createdAt: string;
  displayName: string | null;
  email: string;
  lastActivityAt: string | null;
  lastLoginAt: string | null;
  listeningSeconds: number;
  role: "ADMIN" | "EDITOR";
  listenedBooks: number;
  totalBooks: number;
  updatedAt: string;
  userId: string;
  username: string;
};

async function countAdministrators(connection: Awaited<ReturnType<typeof getConnection>>): Promise<number> {
  const result = await connection.execute(
    `
      SELECT COUNT(*) AS "totalAdmins"
      FROM users
      WHERE role = 'ADMIN'
    `
  );

  const [row] = (result.rows ?? []) as Array<{ totalAdmins: number }>;
  return Number(row?.totalAdmins ?? 0);
}

export const registerUserRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: [authenticateRequest, requireAdministrator] }, async (_request, reply) => {
    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          WITH book_counts AS (
            SELECT owner_user_id AS user_id, COUNT(*) AS total_books
            FROM books
            GROUP BY owner_user_id
          ), event_stats AS (
            SELECT
              user_id,
              MAX(created_at) AS last_event_at,
              MAX(CASE WHEN action = 'LOGIN' THEN created_at END) AS last_login_at
            FROM user_activity_events
            GROUP BY user_id
          ), reading_stats AS (
            SELECT
              user_id,
              SUM(duration_seconds) AS reading_seconds,
              COUNT(DISTINCT book_id) AS started_books,
              MAX(last_activity_at) AS last_reading_at
            FROM user_reading_sessions
            GROUP BY user_id
          )
          SELECT
            u.user_id AS "userId",
            u.username AS "username",
            u.email AS "email",
            u.display_name AS "displayName",
            u.role AS "role",
            u.created_at AS "createdAt",
            u.updated_at AS "updatedAt",
            NVL(bc.total_books, 0) AS "totalBooks",
            NVL(rs.reading_seconds, 0) AS "listeningSeconds",
            NVL(rs.started_books, 0) AS "listenedBooks",
            es.last_login_at AS "lastLoginAt",
            CASE
              WHEN es.last_event_at IS NULL THEN rs.last_reading_at
              WHEN rs.last_reading_at IS NULL THEN es.last_event_at
              WHEN es.last_event_at >= rs.last_reading_at THEN es.last_event_at
              ELSE rs.last_reading_at
            END AS "lastActivityAt"
          FROM users u
          LEFT JOIN book_counts bc ON bc.user_id = u.user_id
          LEFT JOIN event_stats es ON es.user_id = u.user_id
          LEFT JOIN reading_stats rs ON rs.user_id = u.user_id
          ORDER BY NVL(
            CASE
              WHEN es.last_event_at IS NULL THEN rs.last_reading_at
              WHEN rs.last_reading_at IS NULL THEN es.last_event_at
              WHEN es.last_event_at >= rs.last_reading_at THEN es.last_event_at
              ELSE rs.last_reading_at
            END,
            u.created_at
          ) DESC
        `
      );

      return reply.send({ users: result.rows ?? [] });
    } finally {
      await connection.close();
    }
  });

  app.get("/:userId/activity", { preHandler: [authenticateRequest, requireAdministrator] }, async (request, reply) => {
    const params = z.object({ userId: z.string().uuid() }).parse(request.params);
    const connection = await getConnection();

    try {
      const userResult = await connection.execute(
        `
          SELECT
            user_id AS "userId",
            username AS "username",
            display_name AS "displayName"
          FROM users
          WHERE user_id = :userId
        `,
        { userId: params.userId }
      );
      const [user] = (userResult.rows ?? []) as Array<{ displayName: string | null; userId: string; username: string }>;
      if (!user) {
        return reply.status(404).send({ message: "Usuario no encontrado." });
      }

      const summaryResult = await connection.execute(
          `
            SELECT
              (SELECT COUNT(*) FROM user_activity_events WHERE user_id = :userId AND action = 'LOGIN') AS "totalLogins",
              (SELECT COUNT(*) FROM user_activity_events WHERE user_id = :userId AND action = 'BOOK_VIEWED') AS "booksViewed",
              (SELECT COUNT(*) FROM user_activity_events WHERE user_id = :userId AND action = 'BOOK_CREATED') AS "booksCreated",
              (SELECT COUNT(*) FROM user_activity_events WHERE user_id = :userId AND action = 'BOOK_UPDATED') AS "booksUpdated",
              (SELECT COUNT(*) FROM user_activity_events WHERE user_id = :userId AND action = 'BOOK_DELETED') AS "booksDeleted",
              (SELECT NVL(SUM(duration_seconds), 0) FROM user_reading_sessions WHERE user_id = :userId) AS "listeningSeconds"
            FROM dual
          `,
          { userId: params.userId }
        );
      const eventsResult = await connection.execute(
          `
            SELECT * FROM (
              SELECT
                activity_id AS "activityId",
                action AS "action",
                book_id AS "bookId",
                book_title AS "bookTitle",
                ip_address AS "ipAddress",
                user_agent AS "userAgent",
                created_at AS "createdAt"
              FROM user_activity_events
              WHERE user_id = :userId
              ORDER BY created_at DESC
            ) WHERE ROWNUM <= 60
          `,
          { userId: params.userId }
        );
      const booksResult = await connection.execute(
          `
            SELECT
              rs.book_id AS "bookId",
              b.title AS "bookTitle",
              SUM(rs.duration_seconds) AS "listeningSeconds",
              COUNT(*) AS "sessionCount",
              MAX(rs.last_activity_at) AS "lastListenedAt"
            FROM user_reading_sessions rs
            JOIN books b ON b.book_id = rs.book_id
            WHERE rs.user_id = :userId
            GROUP BY rs.book_id, b.title
            ORDER BY MAX(rs.last_activity_at) DESC
          `,
          { userId: params.userId }
        );

      const [summary] = (summaryResult.rows ?? []) as Array<Record<string, unknown>>;
      return reply.send({
        books: booksResult.rows ?? [],
        events: eventsResult.rows ?? [],
        summary: summary ?? {},
        user
      });
    } finally {
      await connection.close();
    }
  });

  app.post("/", { preHandler: [authenticateRequest, requireAdministrator] }, async (request, reply) => {
    const payload = createUserSchema.parse(request.body);
    const connection = await getConnection();
    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(payload.password, 12);

    try {
      await connection.execute(
        `
          INSERT INTO users (
            user_id,
            username,
            email,
            display_name,
            password_hash,
            role
          ) VALUES (
            :userId,
            :username,
            :email,
            :displayName,
            :passwordHash,
            :role
          )
        `,
        {
          displayName: payload.displayName ?? null,
          email: payload.email.toLowerCase(),
          passwordHash,
          role: payload.role,
          userId,
          username: payload.username.toLowerCase()
        },
        {
          autoCommit: true
        }
      );

      return reply.status(201).send({
        user: {
          displayName: payload.displayName ?? null,
          email: payload.email.toLowerCase(),
          role: payload.role,
          userId,
          username: payload.username.toLowerCase()
        }
      });
    } catch (error) {
      if ((error as { errorNum?: number }).errorNum === 1) {
        return reply.status(409).send({ message: "Ya existe un usuario con ese nombre o correo." });
      }

      throw error;
    } finally {
      await connection.close();
    }
  });

  app.put("/:userId", { preHandler: [authenticateRequest, requireAdministrator] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({ userId: z.string().uuid() }).parse(request.params);
    const payload = updateUserSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const userResult = await connection.execute(
        `
          SELECT
            user_id AS "userId",
            role AS "role"
          FROM users
          WHERE user_id = :userId
        `,
        {
          userId: params.userId
        }
      );

      const [user] = (userResult.rows ?? []) as Array<{ role: "ADMIN" | "EDITOR"; userId: string }>;
      if (!user) {
        return reply.status(404).send({ message: "Usuario no encontrado." });
      }

      if (request.currentUser.userId === user.userId && request.currentUser.role === "ADMIN" && payload.role !== "ADMIN") {
        return reply.status(409).send({ message: "No puedes retirarte a ti mismo el perfil de administrador." });
      }

      if (user.role === "ADMIN" && payload.role !== "ADMIN") {
        const adminCount = await countAdministrators(connection);
        if (adminCount <= 1) {
          return reply.status(409).send({ message: "Debe existir al menos un administrador." });
        }
      }

      const parameters: Record<string, unknown> = {
        displayName: payload.displayName ?? null,
        email: payload.email.toLowerCase(),
        role: payload.role,
        userId: user.userId
      };
      const passwordFragment = payload.password
        ? ", password_hash = :passwordHash"
        : "";

      if (payload.password) {
        parameters.passwordHash = await bcrypt.hash(payload.password, 12);
      }

      await connection.execute(
        `
          UPDATE users
          SET display_name = :displayName,
              email = :email,
              role = :role${passwordFragment}
          WHERE user_id = :userId
        `,
        parameters,
        {
          autoCommit: true
        }
      );

      return reply.status(204).send();
    } catch (error) {
      if ((error as { errorNum?: number }).errorNum === 1) {
        return reply.status(409).send({ message: "Ya existe un usuario con ese correo." });
      }

      throw error;
    } finally {
      await connection.close();
    }
  });

  app.delete("/:userId", { preHandler: [authenticateRequest, requireAdministrator] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({ userId: z.string().uuid() }).parse(request.params);
    const connection = await getConnection();

    try {
      const userResult = await connection.execute(
        `
          SELECT
            user_id AS "userId",
            role AS "role"
          FROM users
          WHERE user_id = :userId
        `,
        {
          userId: params.userId
        }
      );

      const [user] = (userResult.rows ?? []) as Array<{ role: "ADMIN" | "EDITOR"; userId: string }>;
      if (!user) {
        return reply.status(404).send({ message: "Usuario no encontrado." });
      }

      if (request.currentUser.userId === user.userId) {
        return reply.status(409).send({ message: "No puedes borrar tu propio usuario." });
      }

      if (user.role === "ADMIN") {
        const adminCount = await countAdministrators(connection);
        if (adminCount <= 1) {
          return reply.status(409).send({ message: "Debe existir al menos un administrador." });
        }
      }

      await connection.execute(
        `
          DELETE FROM users
          WHERE user_id = :userId
        `,
        {
          userId: user.userId
        },
        {
          autoCommit: true
        }
      );

      return reply.status(204).send();
    } finally {
      await connection.close();
    }
  });
};

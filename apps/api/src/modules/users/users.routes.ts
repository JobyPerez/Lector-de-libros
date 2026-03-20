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
  role: "ADMIN" | "EDITOR";
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
          SELECT
            u.user_id AS "userId",
            u.username AS "username",
            u.email AS "email",
            u.display_name AS "displayName",
            u.role AS "role",
            u.created_at AS "createdAt",
            u.updated_at AS "updatedAt",
            COUNT(b.book_id) AS "totalBooks"
          FROM users u
          LEFT JOIN books b
            ON b.owner_user_id = u.user_id
          GROUP BY
            u.user_id,
            u.username,
            u.email,
            u.display_name,
            u.role,
            u.created_at,
            u.updated_at
          ORDER BY LOWER(u.username) ASC
        `
      );

      return reply.send({ users: result.rows ?? [] });
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
import { createHash, randomBytes, randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { appEnv } from "../../config/env.js";
import { sendPasswordResetEmail } from "../../services/mailer.js";

export type UserRole = "ADMIN" | "EDITOR";

type AuthUser = {
  userId: string;
  username: string;
  email: string;
  displayName: string | null;
  role: UserRole;
};

type AuthenticatedJwtPayload = JwtPayload & {
  sub: string;
  displayName?: string | null;
  username?: string;
  email?: string;
  role?: UserRole;
  type: "access" | "refresh";
  jti?: string;
};

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: AuthUser;
  }
}

const registerSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_.-]+$/),
  email: z.string().email(),
  password: z.string().min(8).max(72),
  displayName: z.string().trim().min(1).max(120).optional()
});

const loginSchema = z.object({
  usernameOrEmail: z.string().min(3).max(255),
  password: z.string().min(8).max(72)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const forgotPasswordSchema = z.object({
  email: z.string().email()
});

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(72),
  token: z.string().min(1)
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function signAccessToken(user: AuthUser): string {
  return jwt.sign(
    {
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      type: "access",
      username: user.username
    },
    appEnv.jwtAccessSecret,
    {
      expiresIn: "15m",
      subject: user.userId
    }
  );
}

function signRefreshToken(userId: string): { refreshToken: string; refreshTokenId: string } {
  const refreshTokenId = randomUUID();

  return {
    refreshToken: jwt.sign(
      {
        type: "refresh"
      },
      appEnv.jwtRefreshSecret,
      {
        expiresIn: "30d",
        jwtid: refreshTokenId,
        subject: userId
      }
    ),
    refreshTokenId
  };
}

function verifyAccessToken(token: string): AuthenticatedJwtPayload {
  const payload = jwt.verify(token, appEnv.jwtAccessSecret);

  if (typeof payload === "string" || payload.type !== "access" || typeof payload.sub !== "string") {
    throw new Error("Invalid access token.");
  }

  return payload as AuthenticatedJwtPayload;
}

function verifyRefreshToken(token: string): AuthenticatedJwtPayload {
  const payload = jwt.verify(token, appEnv.jwtRefreshSecret);

  if (typeof payload === "string" || payload.type !== "refresh" || typeof payload.sub !== "string" || typeof payload.jti !== "string") {
    throw new Error("Invalid refresh token.");
  }

  return payload as AuthenticatedJwtPayload;
}

async function findUserByIdentifier(identifier: string): Promise<(AuthUser & { passwordHash: string }) | null> {
  const connection = await getConnection();

  try {
    const result = await connection.execute(
      `
        SELECT
          user_id AS "userId",
          username AS "username",
          email AS "email",
          display_name AS "displayName",
          role AS "role",
          password_hash AS "passwordHash"
        FROM users
        WHERE LOWER(username) = :identifier OR LOWER(email) = :identifier
      `,
      {
        identifier: identifier.toLowerCase()
      }
    );

    const [row] = (result.rows ?? []) as Array<AuthUser & { passwordHash: string }>;
    return row ?? null;
  } finally {
    await connection.close();
  }
}

async function findUserById(userId: string, existingConnection?: Awaited<ReturnType<typeof getConnection>>): Promise<AuthUser | null> {
  const connection = existingConnection ?? (await getConnection());

  try {
    const result = await connection.execute(
      `
        SELECT
          user_id AS "userId",
          username AS "username",
          email AS "email",
          display_name AS "displayName",
          role AS "role"
        FROM users
        WHERE user_id = :userId
      `,
      {
        userId
      }
    );

    const [row] = (result.rows ?? []) as AuthUser[];
    return row ?? null;
  } finally {
    if (!existingConnection) {
      await connection.close();
    }
  }
}

async function countUsers(): Promise<number> {
  const connection = await getConnection();

  try {
    const result = await connection.execute(
      `
        SELECT COUNT(*) AS "totalUsers"
        FROM users
      `
    );

    const [row] = (result.rows ?? []) as Array<{ totalUsers: number }>;
    return Number(row?.totalUsers ?? 0);
  } finally {
    await connection.close();
  }
}

async function createPasswordResetToken(userId: string, connection: Awaited<ReturnType<typeof getConnection>>): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");

  await connection.execute(
    `
      UPDATE password_reset_tokens
      SET used_at = SYSTIMESTAMP
      WHERE user_id = :userId
        AND used_at IS NULL
    `,
    {
      userId
    }
  );

  await connection.execute(
    `
      INSERT INTO password_reset_tokens (
        reset_token_id,
        user_id,
        token_hash,
        expires_at
      ) VALUES (
        :resetTokenId,
        :userId,
        :tokenHash,
        :expiresAt
      )
    `,
    {
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      resetTokenId: randomUUID(),
      tokenHash: hashToken(rawToken),
      userId
    }
  );

  return rawToken;
}

async function issueSession(user: AuthUser, metadata: { ipAddress: string | null; userAgent: string | null }) {
  const accessToken = signAccessToken(user);
  const { refreshToken, refreshTokenId } = signRefreshToken(user.userId);
  const refreshTokenHash = hashToken(refreshToken);
  const connection = await getConnection();

  try {
    await connection.execute(
      `
        INSERT INTO user_refresh_tokens (
          refresh_token_id,
          user_id,
          token_hash,
          expires_at,
          user_agent,
          ip_address
        ) VALUES (
          :refreshTokenId,
          :userId,
          :tokenHash,
          :expiresAt,
          :userAgent,
          :ipAddress
        )
      `,
      {
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        ipAddress: metadata.ipAddress,
        refreshTokenId,
        tokenHash: refreshTokenHash,
        userAgent: metadata.userAgent,
        userId: user.userId
      },
      {
        autoCommit: true
      }
    );
  } finally {
    await connection.close();
  }

  return {
    accessToken,
    refreshToken,
    user
  };
}

export async function authenticateRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorizationHeader = request.headers.authorization;

  if (!authorizationHeader?.startsWith("Bearer ")) {
    await reply.status(401).send({ message: "Missing bearer token." });
    return;
  }

  try {
    const token = authorizationHeader.slice("Bearer ".length).trim();
    const payload = verifyAccessToken(token);
    const user = await findUserById(payload.sub);

    if (!user) {
      await reply.status(401).send({ message: "Usuario no encontrado." });
      return;
    }

    request.currentUser = user;
  } catch {
    await reply.status(401).send({ message: "Invalid or expired access token." });
  }
}

export async function requireAdministrator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.currentUser) {
    await reply.status(401).send({ message: "Unauthenticated request." });
    return;
  }

  if (request.currentUser.role !== "ADMIN") {
    await reply.status(403).send({ message: "Solo los administradores pueden realizar esta acción." });
  }
}

export const registerAuthRoutes: FastifyPluginAsync = async (app) => {
  app.post("/register", async (request, reply) => {
    const payload = registerSchema.parse(request.body);
    const totalUsers = await countUsers();

    if (totalUsers > 0) {
      return reply.status(403).send({ message: "El alta pública está deshabilitada. Un administrador debe crear los usuarios." });
    }

    const passwordHash = await bcrypt.hash(payload.password, 12);
    const userId = randomUUID();
    const normalizedUsername = payload.username.toLowerCase();
    const user: AuthUser = {
      displayName: payload.displayName ?? null,
      email: payload.email.toLowerCase(),
      role: normalizedUsername === "joby" || totalUsers === 0 ? "ADMIN" : "EDITOR",
      userId,
      username: normalizedUsername
    };

    const connection = await getConnection();

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
          displayName: user.displayName,
          email: user.email,
          passwordHash,
          role: user.role,
          userId: user.userId,
          username: user.username
        },
        {
          autoCommit: true
        }
      );
    } catch (error) {
      await connection.close();

      if ((error as { errorNum?: number }).errorNum === 1) {
        return reply.status(409).send({ message: "Username or email already exists." });
      }

      throw error;
    }

    await connection.close();

    const session = await issueSession(user, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers["user-agent"] ?? null
    });

    return reply.status(201).send(session);
  });

  app.post("/login", async (request, reply) => {
    const payload = loginSchema.parse(request.body);
    const user = await findUserByIdentifier(payload.usernameOrEmail);

    if (!user) {
      return reply.status(401).send({ message: "Invalid credentials." });
    }

    const passwordMatches = await bcrypt.compare(payload.password, user.passwordHash);
    if (!passwordMatches) {
      return reply.status(401).send({ message: "Invalid credentials." });
    }

    const session = await issueSession(
      {
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        userId: user.userId,
        username: user.username
      },
      {
        ipAddress: request.ip ?? null,
        userAgent: request.headers["user-agent"] ?? null
      }
    );

    return reply.send(session);
  });

  app.post("/refresh", async (request, reply) => {
    const payload = refreshSchema.parse(request.body);

    let refreshPayload: AuthenticatedJwtPayload;
    try {
      refreshPayload = verifyRefreshToken(payload.refreshToken);
    } catch {
      return reply.status(401).send({ message: "Invalid or expired refresh token." });
    }

    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          SELECT refresh_token_id AS "refreshTokenId"
          FROM user_refresh_tokens
          WHERE refresh_token_id = :refreshTokenId
            AND user_id = :userId
            AND token_hash = :tokenHash
            AND revoked_at IS NULL
            AND expires_at > SYSTIMESTAMP
        `,
        {
          refreshTokenId: refreshPayload.jti,
          tokenHash: hashToken(payload.refreshToken),
          userId: refreshPayload.sub
        }
      );

      if ((result.rows ?? []).length === 0) {
        return reply.status(401).send({ message: "Refresh token is not active." });
      }

      const user = await findUserById(refreshPayload.sub, connection);
      if (!user) {
        return reply.status(404).send({ message: "User not found." });
      }

      await connection.execute(
        `
          UPDATE user_refresh_tokens
          SET revoked_at = SYSTIMESTAMP,
              last_used_at = SYSTIMESTAMP
          WHERE refresh_token_id = :refreshTokenId
        `,
        {
          refreshTokenId: refreshPayload.jti
        },
        {
          autoCommit: true
        }
      );

      const session = await issueSession(user, {
        ipAddress: request.ip ?? null,
        userAgent: request.headers["user-agent"] ?? null
      });

      return reply.send(session);
    } finally {
      await connection.close();
    }
  });

  app.post("/forgot-password", async (request, reply) => {
    const payload = forgotPasswordSchema.parse(request.body);
    const connection = await getConnection();
    const genericResponse = { message: "Si existe una cuenta para ese correo, recibirás un mensaje con instrucciones para recuperar la contraseña." };

    try {
      const result = await connection.execute(
        `
          SELECT
            user_id AS "userId",
            email AS "email",
            display_name AS "displayName"
          FROM users
          WHERE LOWER(email) = :email
        `,
        {
          email: payload.email.toLowerCase()
        }
      );

      const [user] = (result.rows ?? []) as Array<{ displayName: string | null; email: string; userId: string }>;
      if (!user) {
        return reply.send(genericResponse);
      }

      const resetToken = await createPasswordResetToken(user.userId, connection);
      await sendPasswordResetEmail({
        resetToken,
        toEmail: user.email,
        toName: user.displayName
      });
      await connection.commit();

      return reply.send(genericResponse);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.post("/reset-password", async (request, reply) => {
    const payload = resetPasswordSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          SELECT
            prt.reset_token_id AS "resetTokenId",
            prt.user_id AS "userId"
          FROM password_reset_tokens prt
          WHERE prt.token_hash = :tokenHash
            AND prt.used_at IS NULL
            AND prt.expires_at > SYSTIMESTAMP
        `,
        {
          tokenHash: hashToken(payload.token)
        }
      );

      const [tokenRow] = (result.rows ?? []) as Array<{ resetTokenId: string; userId: string }>;
      if (!tokenRow) {
        return reply.status(400).send({ message: "El enlace de recuperación ya no es válido." });
      }

      const passwordHash = await bcrypt.hash(payload.password, 12);

      await connection.execute(
        `
          UPDATE users
          SET password_hash = :passwordHash
          WHERE user_id = :userId
        `,
        {
          passwordHash,
          userId: tokenRow.userId
        }
      );

      await connection.execute(
        `
          UPDATE password_reset_tokens
          SET used_at = SYSTIMESTAMP
          WHERE reset_token_id = :resetTokenId
        `,
        {
          resetTokenId: tokenRow.resetTokenId
        }
      );

      await connection.execute(
        `
          UPDATE user_refresh_tokens
          SET revoked_at = SYSTIMESTAMP,
              last_used_at = SYSTIMESTAMP
          WHERE user_id = :userId
            AND revoked_at IS NULL
        `,
        {
          userId: tokenRow.userId
        }
      );

      await connection.commit();

      return reply.status(204).send();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.post("/logout", async (request, reply) => {
    const payload = refreshSchema.parse(request.body);
    const connection = await getConnection();

    try {
      await connection.execute(
        `
          UPDATE user_refresh_tokens
          SET revoked_at = SYSTIMESTAMP,
              last_used_at = SYSTIMESTAMP
          WHERE token_hash = :tokenHash
            AND revoked_at IS NULL
        `,
        {
          tokenHash: hashToken(payload.refreshToken)
        },
        {
          autoCommit: true
        }
      );
    } finally {
      await connection.close();
    }

    return reply.status(204).send();
  });

  app.get("/me", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const user = await findUserById(request.currentUser.userId);
    if (!user) {
      return reply.status(404).send({ message: "User not found." });
    }

    return reply.send({ user });
  });
};
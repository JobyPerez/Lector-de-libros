import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { getDatabaseStatus } from "./config/database.js";
import { appEnv } from "./config/env.js";
import { registerAnnotationRoutes } from "./modules/annotations/annotations.routes.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { registerBookRoutes } from "./modules/books/books.routes.js";
import { registerProgressRoutes } from "./modules/progress/progress.routes.js";
import { registerTtsRoutes } from "./modules/tts/tts.routes.js";
import { registerUserRoutes } from "./modules/users/users.routes.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: appEnv.nodeEnv === "development" ? "info" : "warn"
    }
  });

  void app.register(cors, {
    origin: appEnv.webOrigin,
    credentials: true
  });

  void app.register(multipart, {
    limits: {
      fileSize: 15 * 1024 * 1024,
      files: 30
    }
  });

  app.get("/health", async (_request, reply) => {
    const database = getDatabaseStatus();
    const isHealthy = database.state === "ready" || database.state === "idle";

    reply.status(database.state === "error" ? 503 : 200);

    return {
      database,
      service: "lector-api",
      status: isHealthy ? "ok" : "degraded"
    };
  });

  void app.register(registerAnnotationRoutes);
  void app.register(registerAuthRoutes, { prefix: "/auth" });
  void app.register(registerBookRoutes, { prefix: "/books" });
  void app.register(registerProgressRoutes);
  void app.register(registerTtsRoutes);
  void app.register(registerUserRoutes, { prefix: "/users" });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      const field = firstIssue?.path.join(".") ?? "input";
      const message = firstIssue?.message ?? "Datos de entrada inválidos.";

      return reply.status(400).send({ message: `${field}: ${message}` });
    }

    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    const message = error instanceof Error ? error.message : "Unexpected application error.";

    reply.status(statusCode).send({
      code: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined,
      message,
      retryAfterSeconds: typeof (error as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number"
        ? (error as { retryAfterSeconds: number }).retryAfterSeconds
        : undefined,
      retryable: (error as { retryable?: unknown }).retryable === true
        ? true
        : undefined
    });
  });

  return app;
}
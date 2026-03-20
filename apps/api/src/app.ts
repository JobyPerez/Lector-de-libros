import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import { appEnv } from "./config/env.js";
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

  app.get("/health", async () => ({
    status: "ok",
    service: "lector-api"
  }));

  void app.register(registerAuthRoutes, { prefix: "/auth" });
  void app.register(registerBookRoutes, { prefix: "/books" });
  void app.register(registerProgressRoutes);
  void app.register(registerTtsRoutes);
  void app.register(registerUserRoutes, { prefix: "/users" });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    const message = error instanceof Error ? error.message : "Unexpected application error.";

    reply.status(statusCode).send({
      message
    });
  });

  return app;
}
import process from "node:process";

import { buildApp } from "./app.js";
import { appEnv } from "./config/env.js";
import { closeConnectionPool, initializeConnectionPool } from "./config/database.js";

const app = buildApp();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "Shutting down API server.");

  try {
    await app.close();
    await closeConnectionPool();
    process.exit(0);
  } catch (error) {
    app.log.error(error, "Error during shutdown.");
    process.exit(1);
  }
}

async function start(): Promise<void> {
  await app.listen({
    host: "0.0.0.0",
    port: appEnv.apiPort
  });

  app.log.info({ port: appEnv.apiPort }, "API server started.");

  void initializeConnectionPool()
    .then(() => {
      app.log.info("Oracle connection pool initialized.");
    })
    .catch((error) => {
      app.log.error(error, "Oracle connection pool unavailable.");
    });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void start().catch(async (error) => {
  app.log.error(error, "Unable to start API server.");
  await closeConnectionPool();
  process.exit(1);
});
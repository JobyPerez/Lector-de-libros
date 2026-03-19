import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import dotenv from "dotenv";

function findWorkspaceRoot(startDirectory: string): string {
  let currentDirectory = startDirectory;

  while (true) {
    const candidate = resolve(currentDirectory, ".env");
    if (existsSync(candidate)) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return startDirectory;
    }

    currentDirectory = parentDirectory;
  }
}

const workspaceRoot = findWorkspaceRoot(process.cwd());
dotenv.config({ path: resolve(workspaceRoot, ".env") });

const pollingIntervalMs = 10_000;

function logHeartbeat() {
  const timestamp = new Date().toISOString();
  console.info(`[worker] ${timestamp} esperando trabajos OCR/TTS.`);
}

logHeartbeat();
setInterval(logHeartbeat, pollingIntervalMs);
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import dotenv from "dotenv";
import { z } from "zod";

function findWorkspaceRoot(startDirectory: string): string {
  let currentDirectory = startDirectory;
  let packageJsonCandidate = startDirectory;

  while (true) {
    if (existsSync(join(currentDirectory, ".git"))) {
      return currentDirectory;
    }

    if (existsSync(join(currentDirectory, "package.json"))) {
      packageJsonCandidate = currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return packageJsonCandidate;
    }

    currentDirectory = parentDirectory;
  }
}

const workspaceRoot = findWorkspaceRoot(process.cwd());
const environmentFilePath = resolve(workspaceRoot, ".env");

if (existsSync(environmentFilePath)) {
  dotenv.config({ path: environmentFilePath });
} else {
  dotenv.config();
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ORACLE_USER: z.string().min(1),
  ORACLE_PASSWORD: z.string().min(1),
  ORACLE_CONNECT_STRING: z.string().min(1),
  ORACLE_WALLET_LOCATION: z.string().min(1),
  ORACLE_WALLET_PASSWORD: z.string().min(1),
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  DEEPGRAM_TTS_MODEL: z.string().min(1).default("aura-2-nestor-es"),
  GITHUB_MODELS_TOKEN: z.string().min(1).optional(),
  GITHUB_MODELS_ENDPOINT: z.string().url().optional(),
  GITHUB_MODELS_VISION_MODEL: z.string().min(1).optional()
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const issues = parsedEnvironment.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid environment configuration. ${issues}`);
}

export const appEnv = {
  workspaceRoot,
  environmentFilePath,
  nodeEnv: parsedEnvironment.data.NODE_ENV,
  apiPort: parsedEnvironment.data.API_PORT,
  webOrigin: parsedEnvironment.data.WEB_ORIGIN,
  jwtAccessSecret: parsedEnvironment.data.JWT_ACCESS_SECRET,
  jwtRefreshSecret: parsedEnvironment.data.JWT_REFRESH_SECRET,
  oracleUser: parsedEnvironment.data.ORACLE_USER,
  oraclePassword: parsedEnvironment.data.ORACLE_PASSWORD,
  oracleConnectString: parsedEnvironment.data.ORACLE_CONNECT_STRING,
  oracleWalletLocation: parsedEnvironment.data.ORACLE_WALLET_LOCATION,
  oracleWalletPassword: parsedEnvironment.data.ORACLE_WALLET_PASSWORD,
  deepgramApiKey: parsedEnvironment.data.DEEPGRAM_API_KEY,
  deepgramTtsModel: parsedEnvironment.data.DEEPGRAM_TTS_MODEL,
  githubModelsToken: parsedEnvironment.data.GITHUB_MODELS_TOKEN,
  githubModelsEndpoint: parsedEnvironment.data.GITHUB_MODELS_ENDPOINT,
  githubModelsVisionModel: parsedEnvironment.data.GITHUB_MODELS_VISION_MODEL
};
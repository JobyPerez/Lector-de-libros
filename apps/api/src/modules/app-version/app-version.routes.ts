import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { FastifyInstance } from "fastify";

import { appEnv } from "../../config/env.js";

type AppCommit = {
  authorName: string;
  authoredAt: string;
  hash: string;
  shortHash: string;
  subject: string;
};

const gitHashPattern = /^[a-f0-9]{7,40}$/iu;
const packageJsonPath = resolve(appEnv.workspaceRoot, "package.json");

function runGit(args: string[]): string {
  return execFileSync("git", args, {
    cwd: appEnv.workspaceRoot,
    encoding: "utf8"
  }).trim();
}

function resolveAppVersion(): string {
  try {
    const rootPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    const baseVersion = rootPackageJson.version ?? "0.1.0";
    const [major = "0", minor = "1"] = baseVersion.split(".");
    const commitCount = runGit(["rev-list", "--count", "HEAD"]);

    return `${major}.${minor}.${commitCount}`;
  } catch {
    return "0.1.0";
  }
}

function resolveCurrentCommitHash(): string {
  try {
    return runGit(["rev-parse", "HEAD"]);
  } catch {
    return "";
  }
}

function resolveCurrentShortCommitHash(): string {
  try {
    return runGit(["rev-parse", "--short", "HEAD"]);
  } catch {
    return "";
  }
}

function parseGitLog(logOutput: string): AppCommit[] {
  if (!logOutput) {
    return [];
  }

  return logOutput
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [shortHash = "", hash = "", authorName = "", authoredAt = "", subject = ""] = entry.split("\x1f");

      return {
        authorName,
        authoredAt,
        hash,
        shortHash,
        subject
      };
    });
}

function resolveCommitsSince(fromCommit: string | undefined, currentCommit: string): { commits: AppCommit[]; rangeFound: boolean } {
  if (!fromCommit || !gitHashPattern.test(fromCommit) || fromCommit === currentCommit) {
    return { commits: [], rangeFound: Boolean(fromCommit && fromCommit === currentCommit) };
  }

  try {
    runGit(["cat-file", "-e", `${fromCommit}^{commit}`]);
    const logOutput = runGit(["log", `${fromCommit}..HEAD`, "--date=iso-strict", "--pretty=format:%h%x1f%H%x1f%an%x1f%aI%x1f%s%x1e"]);

    return {
      commits: parseGitLog(logOutput),
      rangeFound: true
    };
  } catch {
    try {
      const logOutput = runGit(["log", "-n", "10", "--date=iso-strict", "--pretty=format:%h%x1f%H%x1f%an%x1f%aI%x1f%s%x1e"]);
      return {
        commits: parseGitLog(logOutput),
        rangeFound: false
      };
    } catch {
      return { commits: [], rangeFound: false };
    }
  }
}

export async function registerAppVersionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { fromCommit?: string } }>("/app-version", async (request) => {
    const currentCommit = resolveCurrentCommitHash();
    const currentShortCommit = resolveCurrentShortCommitHash();
    const { commits, rangeFound } = resolveCommitsSince(request.query.fromCommit, currentCommit);

    return {
      commits,
      currentCommit,
      currentShortCommit,
      currentVersion: resolveAppVersion(),
      hasUpdate: Boolean(request.query.fromCommit && currentCommit && request.query.fromCommit !== currentCommit),
      rangeFound
    };
  });
}

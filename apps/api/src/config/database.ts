import path from "node:path";

import oracledb from "oracledb";

import { appEnv } from "./env.js";

type OracleConnection = any;
type OracleConnectionPool = {
  close: (drainTime?: number) => Promise<void>;
  getConnection: () => Promise<OracleConnection>;
};

type DatabaseState = "idle" | "initializing" | "ready" | "error";

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];

let connectionPool: OracleConnectionPool | undefined;
let initializationPromise: Promise<OracleConnectionPool> | null = null;
let databaseState: DatabaseState = "idle";
let databaseMessage: string | null = null;

const connectionInitializationTimeoutMs = 15_000;

export class DatabaseUnavailableError extends Error {
  statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}

function resolveWalletLocation(walletLocation: string): string {
  if (path.isAbsolute(walletLocation)) {
    return walletLocation;
  }

  return path.resolve(appEnv.workspaceRoot, walletLocation);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

export function getDatabaseStatus(): { message: string | null; state: DatabaseState } {
  return {
    message: databaseMessage,
    state: databaseState
  };
}

export async function initializeConnectionPool(): Promise<OracleConnectionPool> {
  if (connectionPool) {
    return connectionPool;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  const walletLocation = resolveWalletLocation(appEnv.oracleWalletLocation);
  process.env.TNS_ADMIN = walletLocation;

  databaseState = "initializing";
  databaseMessage = "Conectando con Oracle.";

  initializationPromise = withTimeout(
    oracledb.createPool({
      user: appEnv.oracleUser,
      password: appEnv.oraclePassword,
      connectString: appEnv.oracleConnectString,
      walletLocation,
      walletPassword: appEnv.oracleWalletPassword,
      poolMin: 1,
      poolMax: 10,
      poolIncrement: 1,
      poolTimeout: 60
    }),
    connectionInitializationTimeoutMs,
    `La conexion inicial con Oracle supero ${connectionInitializationTimeoutMs} ms.`
  )
    .then((pool) => {
      connectionPool = pool as OracleConnectionPool;
      databaseState = "ready";
      databaseMessage = null;
      return connectionPool;
    })
    .catch((error) => {
      connectionPool = undefined;
      databaseState = "error";
      databaseMessage = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      initializationPromise = null;
    });

  return initializationPromise;
}

export async function getConnection(): Promise<OracleConnection> {
  if (connectionPool) {
    const connection = await connectionPool.getConnection();
    await connection.execute("ALTER SESSION DISABLE PARALLEL DML");
    return connection;
  }

  if (initializationPromise) {
    throw new DatabaseUnavailableError("La base de datos se esta inicializando. Intenta de nuevo en unos segundos.");
  }

  void initializeConnectionPool().catch(() => undefined);

  if (databaseState === "error") {
    throw new DatabaseUnavailableError("La base de datos no esta disponible en este momento. Reintenta en unos segundos.");
  }

  throw new DatabaseUnavailableError("La base de datos se esta inicializando. Intenta de nuevo en unos segundos.");
}

export async function closeConnectionPool(): Promise<void> {
  initializationPromise = null;

  if (!connectionPool) {
    databaseState = "idle";
    databaseMessage = null;
    return;
  }

  const activePool = connectionPool;
  connectionPool = undefined;
  databaseState = "idle";
  databaseMessage = null;
  await activePool.close(10);
}
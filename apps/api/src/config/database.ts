import path from "node:path";

import oracledb from "oracledb";

import { appEnv } from "./env.js";

type OracleConnection = any;
type OracleConnectionPool = {
  close: (drainTime?: number) => Promise<void>;
  getConnection: () => Promise<OracleConnection>;
};

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];

let connectionPool: OracleConnectionPool | undefined;

function resolveWalletLocation(walletLocation: string): string {
  if (path.isAbsolute(walletLocation)) {
    return walletLocation;
  }

  return path.resolve(appEnv.workspaceRoot, walletLocation);
}

export async function initializeConnectionPool(): Promise<OracleConnectionPool> {
  if (connectionPool) {
    return connectionPool;
  }

  const walletLocation = resolveWalletLocation(appEnv.oracleWalletLocation);
  process.env.TNS_ADMIN = walletLocation;

  connectionPool = await oracledb.createPool({
    user: appEnv.oracleUser,
    password: appEnv.oraclePassword,
    connectString: appEnv.oracleConnectString,
    walletLocation,
    walletPassword: appEnv.oracleWalletPassword,
    poolMin: 1,
    poolMax: 10,
    poolIncrement: 1,
    poolTimeout: 60
  });

  return connectionPool as OracleConnectionPool;
}

export async function getConnection(): Promise<OracleConnection> {
  const pool = connectionPool ?? (await initializeConnectionPool());
  return pool.getConnection();
}

export async function closeConnectionPool(): Promise<void> {
  if (!connectionPool) {
    return;
  }

  const activePool = connectionPool;
  connectionPool = undefined;
  await activePool.close(10);
}
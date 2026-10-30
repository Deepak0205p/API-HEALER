import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import fs from 'fs';
import * as schema from './schema.ts';

declare global {
  var _postgresPoolV2: Pool | undefined;
  var _postgresPoolHost: string | undefined;
}

export function isDatabaseConfigured(): boolean {
  const host = process.env.SQL_HOST?.trim();
  if (!host || !process.env.SQL_USER || !process.env.SQL_DB_NAME) {
    return false;
  }
  if (host.startsWith('/')) {
    return fs.existsSync(host);
  }
  return true;
}

function getPoolConfig(): PoolConfig {
  const rawHost = process.env.SQL_HOST?.trim();
  const isSocket = Boolean(rawHost && rawHost.startsWith('/'));
  const isRemoteTcp = Boolean(
    !isSocket && rawHost && rawHost !== '127.0.0.1' && rawHost !== 'localhost',
  );
  const port = process.env.SQL_PORT ? parseInt(process.env.SQL_PORT, 10) : 5432;

  return {
    host: rawHost,
    port,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SQL_DB_NAME,
    ssl: isRemoteTcp ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  };
}

export const createPool = (): Pool => {
  const currentHost = process.env.SQL_HOST?.trim();
  if (!global._postgresPoolV2 || global._postgresPoolHost !== currentHost) {
    global._postgresPoolV2 = new Pool(getPoolConfig());
    global._postgresPoolHost = currentHost;
    global._postgresPoolV2.on('error', () => {
      // Prevent unhandled idle client errors from crashing the process
    });
  }
  return global._postgresPoolV2;
};

const pool = createPool();

export const db = drizzle(pool, { schema });
export { pool };

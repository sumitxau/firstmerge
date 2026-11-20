import { Pool } from "pg";

const globalForPg = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForPg.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 6,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 8_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPg.pgPool = pool;
}


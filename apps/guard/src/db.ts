import pg from 'pg';
import type { Config } from './config.js';

// BIGINT columns come back as strings by default; amounts here stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(cfg: Config): Db {
  return new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    ssl: cfg.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  });
}

/** Runs fn inside a transaction, committing on success and rolling back on any error. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

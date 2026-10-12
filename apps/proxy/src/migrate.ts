import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/ (tsx) and dist/ (compiled): migrations live next to the package root.
const MIGRATIONS_DIR = path.resolve(here, '..', 'migrations');

/**
 * Minimal forward-only migrator. An advisory lock makes it safe when several instances boot at the
 * same time. Its bookkeeping table is named for this service, so the proxy can share a database
 * with the payment guard without either one skipping the other's migrations.
 */
export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727275)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS spendguard_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM spendguard_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO spendguard_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727275)').catch(() => undefined);
    client.release();
  }
}

// CLI: `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { loadConfig } = await import('./config.js');
  const { createPool } = await import('./db.js');
  const db = createPool(loadConfig());
  await migrate(db);
  await db.end();
}

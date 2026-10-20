import { readdir, readFile } from 'node:fs/promises';
import { createPool, withTransaction } from '../db.js';

const dir = new URL('../../migrations/', import.meta.url);

export async function migrate(pool = createPool()) {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    const sql = await readFile(new URL(name, dir), 'utf8');
    await withTransaction(pool, async (c) => {
      const done = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1 FOR UPDATE', [name]);
      if (done.rowCount) return;
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      console.log(`applied ${name}`);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool();
  await migrate(pool);
  await pool.end();
}

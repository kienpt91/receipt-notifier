import pg from 'pg';
import { config } from './config.js';

// BIGINT (int8) comes back as a string by default. Keep it that way on purpose:
// amounts are converted to bigint explicitly, never through a JS number.
export function createPool(connectionString = config.databaseUrl) {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

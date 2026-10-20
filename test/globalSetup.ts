import pg from 'pg';
import { migrate } from '../src/scripts/migrate.js';

export default async function setup() {
  const admin = new pg.Client({ connectionString: 'postgres://postgres:postgres@localhost:55432/postgres' });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS receipts_test WITH (FORCE)');
  await admin.query('CREATE DATABASE receipts_test');
  await admin.end();

  const pool = new pg.Pool({ connectionString: 'postgres://postgres:postgres@localhost:55432/receipts_test' });
  await migrate(pool);
  await pool.end();
}

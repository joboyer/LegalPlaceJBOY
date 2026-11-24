import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { connection } from '../src/db';

// Integration tests get their own empty database, built from the migrations, so they never
// touch the seeded one. Its name (PGDATABASE in vitest.config.mts) is written out in full: a
// database name cannot be a query parameter, and no SQL in this project is built from a variable.
export default async function setup() {
  const admin = new Client({ ...connection, database: 'postgres' });
  await admin.connect();
  await admin.query('drop database if exists matching_test with (force)');
  await admin.query('create database matching_test');
  await admin.end();

  const client = new Client({ ...connection, database: 'matching_test' });
  await client.connect();
  const migrations = path.join(process.cwd(), 'migrations');
  for (const file of fs.readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    await client.query(fs.readFileSync(path.join(migrations, file), 'utf8'));
  }
  await client.end();
}

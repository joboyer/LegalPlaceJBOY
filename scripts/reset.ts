import fs from 'fs';
import path from 'path';
import { db } from '../src/db';

// The seed is legacy data, written for the initial schema. Later migrations run on top of
// it, the way they would run on production data.
const SEED_SCHEMA = '20260101000000_initial_schema.sql';

function sqlFiles(directory: string): string[] {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(directory, name));
}

async function runSqlFile(file: string) {
  await db.query(fs.readFileSync(file, 'utf8'));
}

async function reset() {
  await db.query('drop schema public cascade');
  await db.query('create schema public');
  for (const migration of sqlFiles(path.join(__dirname, '..', 'migrations'))) {
    await runSqlFile(migration);
    if (path.basename(migration) === SEED_SCHEMA) {
      for (const seed of sqlFiles(path.join(__dirname, '..', 'seeds'))) {
        await runSqlFile(seed);
      }
    }
  }
  // Freshly loaded tables have no planner statistics until autovacuum runs.
  await db.query('analyze');
  await db.end();
}

reset().catch(async (e) => {
  console.error(e);
  await db.end();
  process.exit(1);
});

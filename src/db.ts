import { Pool, types } from 'pg';

// Amounts are stored as bigint cents. They stay far below Number.MAX_SAFE_INTEGER, so reading
// them as JS numbers is exact (pg returns bigint as a string by default).
types.setTypeParser(types.builtins.INT8, Number);

export const db = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  database: process.env.PGDATABASE ?? 'matching',
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // matcher.test.ts runs against Postgres, on a database created by the global setup.
    globalSetup: ['test/global-setup.ts'],
    env: { PGDATABASE: 'matching_test' },
  },
});

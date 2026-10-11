import { defineConfig } from 'vitest/config';

// Every API test file starts its own in-memory Postgres (PGlite). Run in parallel they compete for
// CPU, so starting one can take well over the 10 s default.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});

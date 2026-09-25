import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These tests talk to the real Postgres from docker-compose. Running them in
    // parallel would let one file's fixtures race another's.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ["src/**/*.test.ts"],
  },
});

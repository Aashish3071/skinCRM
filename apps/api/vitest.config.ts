import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These talk to the real Postgres from docker-compose and mutate shared seed
    // rows, so files must not run concurrently.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    env: {
      // Relaxes the credential rate limit and keeps the seed guard honest.
      NODE_ENV: "test",
    },
  },
});

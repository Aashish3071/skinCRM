import { config as loadDotenv } from "dotenv";
import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit bundles this file to CommonJS, which cannot resolve the
 * source-only `@skincrm/config` workspace package. It only needs the connection
 * string, so read the root `.env` directly rather than pulling in the app's
 * config loader.
 */
loadDotenv({ path: new URL("../../.env", import.meta.url).pathname });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env at the repo root.");
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Migrations run as the owner role, which bypasses row-level security.
  dbCredentials: { url },
  verbose: true,
  strict: true,
});

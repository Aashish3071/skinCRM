import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", worker: "src/worker/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  /**
   * Bundle the workspace packages, because they ship TypeScript source rather
   * than a build artifact. Everything from node_modules stays external.
   */
  noExternal: [/^@skincrm\//],
  // Native binaries must resolve at runtime for the deployed platform.
  external: ["@node-rs/argon2"],
  // Bundled CommonJS dependencies (for example dotenv) still load Node builtins.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  splitting: false,
});

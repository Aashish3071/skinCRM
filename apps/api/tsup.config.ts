import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
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
  splitting: false,
});

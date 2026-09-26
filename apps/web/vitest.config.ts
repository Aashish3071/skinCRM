import { defineConfig } from "vitest/config";

export default defineConfig({
  /**
   * Supply an inline (empty) PostCSS config so Vite does not go looking for
   * postcss.config.mjs. Vite's loader cannot resolve Tailwind 4's plugin from a
   * string entry, and it would fail before any test runs. Next.js still uses the
   * real config for `dev` and `build`; no test here asserts on styles.
   */
  css: { postcss: { plugins: [] } },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});

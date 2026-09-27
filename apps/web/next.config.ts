import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  /**
   * The workspace packages export TypeScript source rather than a build artifact
   * (see ARCHITECTURE.md section 2), so Next has to compile them itself.
   */
  transpilePackages: ["@skincrm/contracts", "@skincrm/config"],
  experimental: {
    // Server Actions are the only way the browser mutates data here; the browser
    // never calls the API directly.
    serverActions: { bodySizeLimit: "2mb" },
  },
  poweredByHeader: false,
  // Self-contained server bundle for the production Docker image.
  output: "standalone",
  // Trace files from the monorepo root, so workspace packages are included.
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  // Lets a production build run beside `next dev` without clobbering its
  // output (NEXT_DIST_DIR=.next-build pnpm build).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  typedRoutes: false,
};

export default config;

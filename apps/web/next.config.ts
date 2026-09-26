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
  typedRoutes: false,
};

export default config;

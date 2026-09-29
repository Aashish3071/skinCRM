/** The production boot gate (docs/DEPLOYMENT.md §2). No database needed. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getEnv, resetEnvCache } from "@skincrm/config";

let saved: NodeJS.ProcessEnv;
beforeAll(() => {
  // Load .env once (it is only read on the first call), then snapshot it so
  // each test starts from the real local configuration.
  getEnv();
  saved = { ...process.env };
});
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

const strong = (seed: string) => `${seed}-${"x".repeat(40)}`;

describe("production safety gate", () => {
  it("refuses to boot production with the development placeholders from .env.example", () => {
    process.env.NODE_ENV = "production";
    resetEnvCache();
    expect(() => getEnv()).toThrow(/Refusing to start in production/);
  });

  it("refuses the same value for the session and encryption secrets", () => {
    Object.assign(process.env, { NODE_ENV: "production", SESSION_SECRET: strong("same"), CRYPTO_MASTER_KEY: strong("same") });
    resetEnvCache();
    let message = "";
    try { getEnv(); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("must be different");
  });

  it("boots production with strong, distinct secrets", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      SESSION_SECRET: strong("session"),
      CRYPTO_MASTER_KEY: strong("crypto"),
      CRYPTO_PROVIDER: "local",
      DATABASE_APP_URL: process.env.DATABASE_APP_URL ?? "postgresql://app:pw@localhost:5432/skincrm",
      OUTBOUND_SENDING_ENABLED: "false",
    });
    resetEnvCache();
    expect(getEnv().NODE_ENV).toBe("production");
  });
});

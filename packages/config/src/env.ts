import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * Walk up from the current working directory to find the repo root (the
 * directory holding pnpm-workspace.yaml) so every app reads the same `.env`
 * no matter which package it was started from.
 */
function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

let dotenvLoaded = false;
function ensureDotenv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const root = findRepoRoot();
  // `.env.test` wins when running tests so a test run can never point at a dev DB.
  const candidates =
    process.env.NODE_ENV === "test"
      ? [".env.test", ".env"]
      : [`.env.${process.env.NODE_ENV ?? "development"}.local`, ".env.local", ".env"];
  for (const name of candidates) {
    const path = join(root, name);
    if (existsSync(path)) loadDotenv({ path, override: false });
  }
}

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no"]))
  .transform((v) => v === "true" || v === "1" || v === "yes");

const connectorMode = z.enum(["mock", "live"]).default("mock");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().url(),
  DATABASE_APP_URL: z.string().url().optional(),
  DATABASE_APP_PASSWORD: z.string().min(1).default("skincrm_app_dev_password"),

  REDIS_URL: z.string().url(),

  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  /** Base URL clients reach, used to build unsubscribe and self-service links. */
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:3000"),
  /** Where Meta and Google reach the API's webhooks. Must be public HTTPS in production. */
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),

  SESSION_SECRET: z.string().min(16),
  CRYPTO_PROVIDER: z.enum(["local", "aws-kms"]).default("local"),
  /** Root key passphrase (CRYPTO_PROVIDER=local). Not used with aws-kms. */
  CRYPTO_MASTER_KEY: z.string().min(16).optional(),
  /** AWS KMS key that wraps the root key (aws-kms). Optional: the wrapped blob names it. */
  KMS_KEY_ID: z.string().optional(),
  /** The root key, wrapped by KMS, base64 (`pnpm crypto:new-key`). */
  CRYPTO_WRAPPED_KEY: z.string().optional(),
  /** Decrypt-only keys after a rotation, comma-separated (D-93). */
  CRYPTO_PREVIOUS_WRAPPED_KEYS: z.string().optional(),
  CRYPTO_PREVIOUS_MASTER_KEYS: z.string().optional(),

  CONNECTOR_EMAIL: connectorMode,
  CONNECTOR_WHATSAPP: connectorMode,
  CONNECTOR_META: connectorMode,
  CONNECTOR_GOOGLE: connectorMode,
  CONNECTOR_CALENDAR: connectorMode,

  OUTBOUND_SENDING_ENABLED: booleanish.default("false"),
  /**
   * Run the background worker inside the API process. Convenient for local
   * development (one `pnpm dev` runs everything); in production run the
   * worker as its own process (`node dist/worker.js`) and leave this false.
   */
  WORKER_IN_API: booleanish.default("false"),
  WORKER_POLL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  CONVERSION_FEEDBACK_ENABLED: booleanish.default("false"),

  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** With CONNECTOR_EMAIL=live: plain SMTP relay, or Postmark's API with replies and bounces (D-96). */
  EMAIL_PROVIDER: z.enum(["smtp", "postmark"]).default("smtp"),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  /** The server's inbound address, e.g. abc123@inbound.postmarkapp.com (Servers → Inbound). */
  POSTMARK_INBOUND_ADDRESS: z.string().email().optional(),
  /** Basic-auth credentials put in Postmark's webhook URLs. */
  POSTMARK_WEBHOOK_USER: z.string().optional(),
  POSTMARK_WEBHOOK_PASSWORD: z.string().optional(),
  POSTMARK_TRANSACTIONAL_STREAM: z.string().default("outbound"),
  POSTMARK_BROADCAST_STREAM: z.string().default("broadcast"),
  EMAIL_FROM_ADDRESS: z.string().email().default("noreply@example-clinic.test"),
  EMAIL_FROM_NAME: z.string().default("Example Clinic"),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  /** Optional Facebook Login for Business configuration id (carries the permission set). */
  META_LOGIN_CONFIG_ID: z.string().optional(),
  /** WhatsApp Embedded Signup configuration id (Connect WhatsApp). Public; shown to the browser. */
  META_WA_CONFIG_ID: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default("dev_meta_verify_token"),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().default("dev_whatsapp_verify_token"),

  /** "Connect with Google Ads": the deployment's OAuth client and Ads developer token. */
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  /** Outlook calendar sync (CONNECTOR_CALENDAR=live): an Entra ID app registration. */
  MICROSOFT_OAUTH_CLIENT_ID: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_OAUTH_TENANT: z.string().default("common"),
  GOOGLE_LEAD_FORM_KEY: z.string().default("dev_google_key"),

  /** Where operational alerts go (queue backlog, failing webhooks, backups…). */
  OPS_ALERT_EMAIL: z.string().email().optional(),
  /** Shared secret for GET /health/alerts, for an external uptime monitor. */
  MONITOR_TOKEN: z.string().min(16).optional(),
  /** Alert if no successful backup has been recorded in 26 hours. */
  BACKUPS_EXPECTED: booleanish.default("false"),
  /** Raw provider payloads are kept this long for replay and disputes, then deleted. */
  RAW_PAYLOAD_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  ensureDotenv();
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration.\n${issues}\n\n` +
        `Copy .env.example to .env at the repo root and fill the missing values.`,
    );
  }
  const env = parsed.data;
  if (env.CRYPTO_PROVIDER === "local" && !env.CRYPTO_MASTER_KEY) {
    throw new Error("Invalid environment configuration.\n  - CRYPTO_MASTER_KEY: required when CRYPTO_PROVIDER=local");
  }

  if (env.NODE_ENV === "production") {
    assertProductionSafety(env);
  }
  cached = env;
  return env;
}

/**
 * Refuse to boot production with development placeholders, weak secrets, or a
 * mail setup that would silently swallow every email.
 * A leaked dev key would decrypt every clinic's provider credentials.
 */
function assertProductionSafety(env: Env): void {
  const problems: string[] = [];
  if (env.SESSION_SECRET.includes("dev_only")) problems.push("SESSION_SECRET is still the dev placeholder");
  if (env.CRYPTO_PROVIDER === "local") {
    // D-75: a strong secret from the host's secret manager.
    if (!env.CRYPTO_MASTER_KEY) problems.push("CRYPTO_MASTER_KEY is required with CRYPTO_PROVIDER=local");
    else {
      if (env.CRYPTO_MASTER_KEY.includes("dev_only")) problems.push("CRYPTO_MASTER_KEY is still the dev placeholder");
      if (env.CRYPTO_MASTER_KEY.length < 32) problems.push("CRYPTO_MASTER_KEY must be at least 32 characters (openssl rand -base64 32)");
    }
  } else if (!env.CRYPTO_WRAPPED_KEY) {
    // D-93: the root key exists only wrapped by AWS KMS.
    problems.push("CRYPTO_PROVIDER=aws-kms needs CRYPTO_WRAPPED_KEY (run `pnpm crypto:new-key`)");
  }
  if (env.SESSION_SECRET.length < 32) problems.push("SESSION_SECRET must be at least 32 characters (openssl rand -base64 32)");
  if (env.CRYPTO_MASTER_KEY && env.CRYPTO_MASTER_KEY === env.SESSION_SECRET) problems.push("CRYPTO_MASTER_KEY and SESSION_SECRET must be different");
  if (env.OUTBOUND_SENDING_ENABLED && env.CONNECTOR_EMAIL === "live" && env.EMAIL_PROVIDER === "smtp" && ["localhost", "127.0.0.1"].includes(env.SMTP_HOST))
    problems.push("SMTP_HOST points at localhost (the development mail catcher); set your real email relay");
  if (env.CONNECTOR_EMAIL === "live" && env.EMAIL_PROVIDER === "postmark") {
    if (!env.POSTMARK_SERVER_TOKEN) problems.push("EMAIL_PROVIDER=postmark needs POSTMARK_SERVER_TOKEN");
    if (!env.POSTMARK_WEBHOOK_USER || !env.POSTMARK_WEBHOOK_PASSWORD || env.POSTMARK_WEBHOOK_PASSWORD.length < 16)
      problems.push("EMAIL_PROVIDER=postmark needs POSTMARK_WEBHOOK_USER and a POSTMARK_WEBHOOK_PASSWORD of 16+ characters (the webhooks check them)");
  }
  if (!env.DATABASE_APP_URL)
    problems.push("DATABASE_APP_URL is required in production so runtime queries are subject to row-level security");
  if (problems.length > 0) {
    throw new Error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

/** Connection string the api/worker should use at runtime (RLS-enforced role). */
export function getRuntimeDatabaseUrl(env: Env = getEnv()): string {
  return env.DATABASE_APP_URL ?? env.DATABASE_URL;
}

/** Test helper: forget the cached parse so a test can mutate process.env. */
export function resetEnvCache(): void {
  cached = undefined;
  dotenvLoaded = false;
}

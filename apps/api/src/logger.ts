import { pino } from "pino";
import { getEnv } from "@skincrm/config";

/**
 * Keys that must never reach a log line, at any depth. PRD 8 is explicit: no
 * email tokens or personal data in application logs, and General Notes,
 * WhatsApp message bodies and raw provider payloads are all sensitive even
 * though the product holds no clinical records.
 *
 * Redaction here is a backstop, not the primary control. The rule is to log ids
 * and correlation ids; this list catches the cases where an object is passed
 * whole by mistake.
 */
const REDACTED_KEYS = [
  "password",
  "newPassword",
  "currentPassword",
  "passwordHash",
  "token",
  "tokenHash",
  "accessToken",
  "refreshToken",
  "secret",
  "mfaSecret",
  "mfaSecretEncrypted",
  "totpCode",
  "authorization",
  "cookie",
  "setCookie",
  // Contact details and free text.
  "email",
  "phone",
  "phoneE164",
  "firstName",
  "lastName",
  "fullName",
  "addressLine1",
  "addressLine2",
  "dateOfBirth",
  "body", // message bodies
  "noteBody",
  "rawPayload",
  "userColumnData", // Google lead-form field values
];

/** Redact each key wherever it appears, plus the usual header locations. */
const redactPaths = [
  ...REDACTED_KEYS.map((key) => `*.${key}`),
  ...REDACTED_KEYS.map((key) => key),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export const logger = pino({
  level: getEnv().LOG_LEVEL,
  redact: { paths: redactPaths, censor: "[redacted]" },
  base: { service: "api" },
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(getEnv().NODE_ENV === "development"
    ? { transport: { target: "pino-pretty", options: { colorize: true, singleLine: false } } }
    : {}),
});

/**
 * Strip anything sensitive from an object before it goes into an audit summary
 * or a log line. Used by the audit service so a caller cannot accidentally
 * persist a note body or a phone number into `audit_events.change_summary`.
 *
 * Returns the set of field names that changed, not their values, for anything on
 * the redaction list.
 */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactForAudit(item, depth + 1));
  if (typeof value !== "object") {
    return typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.includes(key)) {
      // Record that the field changed without recording what it became.
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactForAudit(item, depth + 1);
  }
  return out;
}

export { REDACTED_KEYS };

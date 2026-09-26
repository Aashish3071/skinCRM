import { z } from "zod";

export const uuidSchema = z.string().uuid();

/** Trimmed, non-empty string with a max length. Rejects whitespace-only input. */
export const shortText = (max = 255) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1).max(max));

export const optionalShortText = (max = 255) =>
  z
    .string()
    .transform((v) => v.trim())
    .transform((v) => (v === "" ? null : v))
    .pipe(z.string().max(max).nullable())
    .nullish()
    .transform((v) => v ?? null);

export const longText = (max = 20_000) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1).max(max));

export const emailSchema = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().email().max(320));

/** ISO-8601 instant. Everything crossing the API boundary is UTC. */
export const isoDateTime = z.string().datetime({ offset: true });

/** Calendar date in the clinic's timezone, `YYYY-MM-DD`. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/** IANA timezone, e.g. `America/New_York`. Validated against the host ICU data. */
export const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Unknown IANA timezone" },
);

/**
 * A boolean from a query string.
 *
 * `z.coerce.boolean()` is wrong here and dangerously so: it applies
 * `Boolean(value)`, and `Boolean("false")` is `true`. Every `?include=false`
 * would silently mean the opposite of what the caller asked for.
 */
export const queryBoolean = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return defaultValue;
      if (typeof value === "boolean") return value;
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
      return defaultValue;
    });

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    totalCount: z.number().int().nonnegative().optional(),
  });
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  totalCount?: number;
}

/** Stable error envelope for every non-2xx API response. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Field-level validation detail, keyed by dotted path. */
    details: z.record(z.array(z.string())).optional(),
    correlationId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

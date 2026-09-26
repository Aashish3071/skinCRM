import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { LEAD_SOURCES, optionalShortText } from "@skincrm/contracts";
import { schema, withTenant, withoutTenantScope } from "@skincrm/db";
import { generateToken, hashToken } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { badRequest, unauthorized } from "../errors";
import { recordAudit } from "../audit";
import { logger } from "../logger";
import { registerRoute } from "../route";
import { ingestSubmission } from "./pipeline";
import { IMPORTABLE_FIELDS, csvRowExternalId, parseCsv, suggestMapping, validateRow } from "./csv";

const { clinics } = schema;

/** Keeps a single import inside one request transaction and one screen of feedback. */
const MAX_IMPORT_ROWS = 2000;

const mappingSchema = z.record(z.enum(IMPORTABLE_FIELDS), z.string().max(200)).default({});

export function registerIntakeRoutes(app: FastifyInstance): void {
  // --- CSV preview (PRD ID-04) -------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/imports/csv/preview",
    auth: { capability: "people:write" },
    body: z.object({
      csv: z.string().min(1).max(5_000_000),
      mapping: mappingSchema.optional(),
    }),
    status: 200,
    handler: async ({ body }) => {
      const country = await clinicCountry();
      const parsed = parseCsv(body.csv);

      if (parsed.rows.length === 0) {
        throw badRequest("That file has no data rows.");
      }
      if (parsed.rows.length > MAX_IMPORT_ROWS) {
        throw badRequest(
          `That file has ${parsed.rows.length} rows. Split it into files of ${MAX_IMPORT_ROWS} or fewer.`,
        );
      }

      const mapping = body.mapping ?? suggestMapping(parsed.headers);
      const validations = parsed.rows.map((row, index) =>
        validateRow(row, mapping, index + 1, country),
      );

      return {
        fingerprint: parsed.fingerprint,
        headers: parsed.headers,
        mapping,
        totalRows: validations.length,
        validRows: validations.filter((v) => v.valid).length,
        invalidRows: validations.filter((v) => !v.valid).length,
        // Enough to judge the mapping without shipping the whole file back.
        sample: validations.slice(0, 20),
        // Every failure is listed, so nothing is silently dropped.
        problems: validations.filter((v) => !v.valid || v.warnings.length > 0),
      };
    },
  });

  // --- CSV commit ---------------------------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/imports/csv",
    auth: { capability: "people:write" },
    body: z.object({
      csv: z.string().min(1).max(5_000_000),
      mapping: mappingSchema,
      source: z.enum(LEAD_SOURCES).default("csv_import"),
      /** Skip rows that fail validation instead of refusing the whole file. */
      skipInvalid: z.boolean().default(true),
    }),
    status: 200,
    handler: async ({ body }) => {
      const country = await clinicCountry();
      const parsed = parseCsv(body.csv);

      if (parsed.rows.length > MAX_IMPORT_ROWS) {
        throw badRequest(`That file has ${parsed.rows.length} rows. Split it into smaller files.`);
      }

      const validations = parsed.rows.map((row, index) =>
        validateRow(row, mapping(body.mapping), index + 1, country),
      );
      const invalid = validations.filter((v) => !v.valid);

      if (invalid.length > 0 && !body.skipInvalid) {
        throw badRequest(`${invalid.length} rows cannot be imported. Fix them or allow skipping.`, {
          rows: invalid.slice(0, 20).map((v) => `Row ${v.rowNumber}: ${v.errors.join("; ")}`),
        });
      }

      let created = 0;
      let duplicates = 0;
      const failures: { rowNumber: number; reason: string }[] = [];

      for (const validation of validations) {
        if (!validation.valid) {
          failures.push({ rowNumber: validation.rowNumber, reason: validation.errors.join("; ") });
          continue;
        }

        const outcome = await ingestSubmission({
          platform: "csv",
          source: body.source,
          // Deterministic, so re-uploading the same file imports nothing twice.
          externalId: csvRowExternalId(parsed.fingerprint, validation.rowNumber),
          submittedAt: validation.values.submittedAt ? new Date(validation.values.submittedAt) : null,
          firstName: validation.values.firstName,
          lastName: validation.values.lastName,
          phone: validation.values.phone,
          email: validation.values.email,
          serviceInterest: validation.values.serviceInterest,
          inquiryNote: validation.values.note,
          clinicCountry: country,
        });

        if (outcome.status === "created") created += 1;
        else if (outcome.status === "duplicate") duplicates += 1;
        else failures.push({ rowNumber: validation.rowNumber, reason: outcome.reason });
      }

      await recordAudit({
        action: "record_created",
        entityType: "csv_import",
        changeSummary: {
          fingerprint: parsed.fingerprint,
          totalRows: validations.length,
          created,
          duplicates,
          failed: failures.length,
        },
      });

      return {
        fingerprint: parsed.fingerprint,
        totalRows: validations.length,
        created,
        // Re-importing the same file lands entirely here, which is the point.
        duplicates,
        failed: failures.length,
        failures: failures.slice(0, 50),
      };
    },
  });

  // --- Website form key (PRD ID-05) --------------------------------------
  registerRoute(app, {
    method: "POST",
    url: "/settings/website-form-key",
    auth: { capability: "settings:write" },
    status: 200,
    handler: async () => {
      const context = getContext();
      const tx = getTx();
      const { token, tokenHash } = generateToken(24);

      await tx
        .update(clinics)
        .set({ websiteFormKeyHash: tokenHash, updatedAt: new Date() })
        .where(eq(clinics.id, context.clinicId!));

      await recordAudit({
        action: "settings_changed",
        entityType: "clinic",
        entityId: context.clinicId,
        changeSummary: { websiteFormKeyRotated: true },
      });

      // Shown once. Only the hash is stored, so it cannot be recovered later.
      return {
        key: token,
        endpoint: "/webhooks/website",
        note: "Copy this now. It is stored hashed and cannot be shown again.",
      };
    },
  });

  // --- Public website lead endpoint (PRD ID-05) --------------------------
  registerRoute(app, {
    method: "POST",
    url: "/webhooks/website",
    // Public by necessity: it is called by the clinic's own website.
    auth: false,
    // Abuse control. A clinic form does not legitimately fire 60 times a minute
    // from one address.
    rateLimit: { max: 20, timeWindow: "1 minute" },
    body: z.object({
      /** Identifies the clinic. Compared against the stored hash. */
      key: z.string().min(10).max(200),
      firstName: optionalShortText(120),
      lastName: optionalShortText(120),
      phone: optionalShortText(40),
      email: optionalShortText(320),
      serviceInterest: optionalShortText(200),
      message: optionalShortText(4000),
      /** Consent as presented on the form; recorded verbatim with its version. */
      consentGiven: z.boolean().default(false),
      consentText: optionalShortText(4000),
      consentVersion: optionalShortText(60),
      /** Attribution, when the site passes it through. */
      utmSource: optionalShortText(200),
      utmMedium: optionalShortText(200),
      utmCampaign: optionalShortText(200),
      utmTerm: optionalShortText(200),
      utmContent: optionalShortText(200),
      clickId: optionalShortText(500),
      pageUrl: optionalShortText(1000),
      /**
       * Honeypot. A real person leaves it empty; most naive bots fill every
       * field. Silently accepted so the bot learns nothing from the response.
       */
      website: optionalShortText(200),
    }),
    status: 202,
    handler: async ({ body, ctx }) => {
      const clinic = await resolveClinicByFormKey(body.key);
      if (!clinic) {
        // Same shape as a real failure and no hint about which part was wrong.
        throw unauthorized("That form is not configured correctly.");
      }

      if (body.website) {
        // Honeypot tripped. Answer exactly as for a success.
        logger.info({ clinicId: clinic.id }, "Website form honeypot triggered");
        return { status: "received" };
      }

      if (!body.phone?.trim() && !body.email?.trim()) {
        throw badRequest("Give at least a phone number or an email address.");
      }

      // The route helper opens no transaction for a public route, so open one
      // scoped to the clinic the key resolved to.
      const outcome = await withTenant(
        clinic.id,
        async (tx) => {
          ctx.clinicId = clinic.id;
          ctx.tx = tx;
          try {
            return await ingestSubmission({
              platform: "website",
              source: "website_form",
              // The site does not supply an id, so make one that is unique per
              // submission rather than reusing a value that could collide.
              externalId: `website:${crypto.randomUUID()}`,
              firstName: body.firstName ?? null,
              lastName: body.lastName ?? null,
              phone: body.phone ?? null,
              email: body.email ?? null,
              serviceInterest: body.serviceInterest ?? null,
              inquiryNote: body.message ?? null,
              clinicCountry: clinic.country,
              attribution: {
                utmSource: body.utmSource ?? null,
                utmMedium: body.utmMedium ?? null,
                utmCampaign: body.utmCampaign ?? null,
                utmTerm: body.utmTerm ?? null,
                utmContent: body.utmContent ?? null,
                clickId: body.clickId ?? null,
              },
              consent: body.consentGiven
                ? [
                    {
                      channel: "email",
                      purpose: "operational",
                      source: "web_form",
                      noticeVersion: body.consentVersion ?? null,
                      capturedText: body.consentText ?? null,
                    },
                  ]
                : [],
              rawPayload: { ...body, key: "[redacted]" },
            });
          } finally {
            ctx.tx = null;
          }
        },
        { actorUserId: null },
      );

      if (outcome.status === "failed") {
        throw badRequest(outcome.reason);
      }

      // Deliberately uninformative about what happened internally: the caller is
      // a public web page and does not need to know whether a person matched.
      return { status: "received" };
    },
  });
}

function mapping(value: Record<string, string>): Record<string, string> {
  return value ?? {};
}

/**
 * Find the clinic a website form key belongs to.
 *
 * Genuinely cross-tenant: the key is the only thing identifying the clinic, so
 * the lookup cannot be scoped before it runs.
 */
async function resolveClinicByFormKey(key: string): Promise<{ id: string; country: string } | null> {
  const keyHash = hashToken(key);
  const rows = await withoutTenantScope(
    "resolve website form key before the clinic is known",
    async (db) =>
      db
        .select({ id: clinics.id, country: clinics.country, archivedAt: clinics.archivedAt })
        .from(clinics)
        .where(eq(clinics.websiteFormKeyHash, keyHash))
        .limit(1),
  );
  const clinic = rows[0];
  if (!clinic || clinic.archivedAt) return null;
  return { id: clinic.id, country: clinic.country };
}

async function clinicCountry(): Promise<string> {
  const tx = getTx();
  const rows = await tx.select({ country: clinics.country }).from(clinics).limit(1);
  return rows[0]?.country ?? "US";
}

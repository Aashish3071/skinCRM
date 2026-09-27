import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  LOGO_MAX_BYTES,
  clinicProfileSchema,
  updateMyProfileSchema,
  uploadLogoSchema,
} from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { badRequest, notFound } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";

const { clinics, users } = schema;

/** Magic numbers, so a renamed file can't pass as an image. */
function sniff(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function registerProfileRoutes(app: FastifyInstance): void {
  // --- Clinic profile -----------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/settings/clinic",
    auth: { capability: "settings:read" },
    handler: async () => {
      const c = (await getTx().select().from(clinics).limit(1))[0]!;
      return {
        name: c.name,
        phone: c.phone,
        website: c.website,
        supportEmail: c.supportEmail,
        postalAddress: c.postalAddress,
        timezone: c.timezone,
        logoVersion: c.logoUpdatedAt ? c.logoUpdatedAt.getTime().toString(36) : null,
      };
    },
  });

  registerRoute(app, {
    method: "PATCH",
    url: "/settings/clinic",
    auth: { capability: "settings:write" },
    body: clinicProfileSchema,
    handler: async ({ body }) => {
      const tx = getTx();
      const before = (await tx.select().from(clinics).limit(1))[0]!;
      await tx.update(clinics).set({ ...body, updatedAt: new Date() }).where(eq(clinics.id, before.id));
      await recordAudit({
        action: "settings_changed",
        entityType: "clinic",
        entityId: before.id,
        changeSummary: {
          profile: Object.keys(body).filter((k) => (before as Record<string, unknown>)[k] !== (body as Record<string, unknown>)[k]),
        },
      });
      return { ok: true };
    },
  });

  registerRoute(app, {
    method: "PUT",
    url: "/settings/clinic/logo",
    auth: { capability: "settings:write" },
    body: uploadLogoSchema,
    handler: async ({ body }) => {
      const base64 = body.dataUrl.slice(body.dataUrl.indexOf(",") + 1);
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length > LOGO_MAX_BYTES) throw badRequest("That image is over 512 KB. Use a smaller version.");
      const mime = sniff(bytes);
      if (!mime) throw badRequest("That file isn't a PNG, JPG or WebP image.");
      const tx = getTx();
      const clinicId = getContext().clinicId!;
      const now = new Date();
      await tx.update(clinics).set({ logoData: base64, logoMime: mime, logoUpdatedAt: now, updatedAt: now }).where(eq(clinics.id, clinicId));
      await recordAudit({ action: "settings_changed", entityType: "clinic", entityId: clinicId, changeSummary: { logo: "uploaded", bytes: bytes.length } });
      return { logoVersion: now.getTime().toString(36) };
    },
  });

  registerRoute(app, {
    method: "DELETE",
    url: "/settings/clinic/logo",
    auth: { capability: "settings:write" },
    status: 204,
    handler: async () => {
      const clinicId = getContext().clinicId!;
      await getTx().update(clinics).set({ logoData: null, logoMime: null, logoUpdatedAt: null }).where(eq(clinics.id, clinicId));
      await recordAudit({ action: "settings_changed", entityType: "clinic", entityId: clinicId, changeSummary: { logo: "removed" } });
      return null;
    },
  });

  /** The logo image, for anyone signed in to this clinic. */
  registerRoute(app, {
    method: "GET",
    url: "/clinic/logo",
    auth: {},
    handler: async ({ reply }) => {
      const c = (await getTx().select({ data: clinics.logoData, mime: clinics.logoMime }).from(clinics).limit(1))[0];
      if (!c?.data || !c.mime) throw notFound("No logo.");
      // Versioned URLs (?v=…) change on upload, so the browser may cache hard.
      reply
        .header("content-type", c.mime)
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .send(Buffer.from(c.data, "base64"));
      return undefined;
    },
  });

  // --- My profile ---------------------------------------------------------------
  registerRoute(app, {
    method: "PATCH",
    url: "/me",
    auth: {},
    body: updateMyProfileSchema,
    handler: async ({ body }) => {
      const context = getContext();
      await getTx().update(users).set({ fullName: body.fullName, updatedAt: new Date() }).where(eq(users.id, context.userId!));
      await recordAudit({ action: "record_updated", entityType: "user", entityId: context.userId!, changeSummary: { fullName: "changed" } });
      return { ok: true };
    },
  });
}

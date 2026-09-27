import { z } from "zod";
import { optionalShortText, shortText, timezoneSchema } from "./common";

/** Settings → Clinic profile and My profile. */

export const clinicProfileSchema = z.object({
  name: shortText(120),
  phone: optionalShortText(40),
  website: optionalShortText(200),
  supportEmail: optionalShortText(200),
  postalAddress: optionalShortText(300),
  timezone: timezoneSchema,
});
export type ClinicProfile = z.infer<typeof clinicProfileSchema>;

/** Logo upload as a data URL. PNG, JPEG or WebP only — SVG can carry scripts. */
export const LOGO_MAX_BYTES = 512 * 1024;
export const uploadLogoSchema = z.object({
  dataUrl: z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Use a PNG, JPG or WebP image").max(800_000),
});

export const updateMyProfileSchema = z.object({
  fullName: shortText(200),
});

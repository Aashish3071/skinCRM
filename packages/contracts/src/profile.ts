import { z } from "zod";
import { optionalShortText, shortText, timezoneSchema } from "./common";
import { optionalEmailField, optionalPhoneField, personNameField } from "./contact";

/** Settings → Clinic profile and My profile. */

/** A web address, with or without https:// (e.g. sunshineskin.com). */
const optionalWebsiteField = optionalShortText(200).superRefine((value, ctx) => {
  if (value === null) return;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let ok = false;
  try {
    const url = new URL(withScheme);
    ok = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname) && !/\s/.test(value);
  } catch {
    ok = false;
  }
  if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a web address, like sunshineskin.com." });
});

export const clinicProfileSchema = z.object({
  name: shortText(120),
  phone: optionalPhoneField,
  website: optionalWebsiteField,
  supportEmail: optionalEmailField,
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
  fullName: personNameField(200),
});

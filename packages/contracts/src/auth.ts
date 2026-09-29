import { z } from "zod";
import { emailSchema, shortText, uuidSchema } from "./common";
import { USER_ROLES, USER_STATUSES } from "./enums";
import { CAPABILITIES } from "./permissions";
import { personNameField } from "./contact";

/**
 * Password policy. Length is the dominant factor, so we require 12 characters
 * and screen against a breach/common list rather than demanding character
 * classes that push users toward `Password1!`.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /** 6-digit TOTP code, required when the account has MFA enabled. */
  totpCode: z
    .string()
    .regex(/^\d{6}$/, "Enter the 6-digit code")
    .optional(),
  /**
   * Which clinic to sign in to. Email is unique per clinic rather than globally,
   * so the same address can belong to staff at two clinics on the platform. It is
   * only needed after the server has replied `clinic_selection_required`.
   */
  clinicId: uuidSchema.optional(),
  /** One-time MFA recovery code, as an alternative to `totpCode`. */
  recoveryCode: z.string().min(8).max(32).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionUserSchema = z.object({
  id: uuidSchema,
  clinicId: uuidSchema,
  email: z.string().email(),
  fullName: z.string(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  capabilities: z.array(z.enum(CAPABILITIES)),
  mfaEnabled: z.boolean(),
  /** Branches the user may act in. Empty means every branch in the clinic. */
  branchIds: z.array(uuidSchema),
  clinic: z.object({
    id: uuidSchema,
    name: z.string(),
    timezone: z.string(),
    country: z.string(),
    /** Changes whenever the logo does; null means no logo uploaded. */
    logoVersion: z.string().nullable(),
  }),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const loginResponseSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("authenticated"), user: sessionUserSchema }),
  /** Credentials were right but a TOTP code is still needed. */
  z.object({ result: z.literal("mfa_required") }),
  /**
   * The password matched staff accounts at more than one clinic. Only returned
   * after the password is verified, so it discloses nothing to an attacker who
   * does not already hold the credentials.
   */
  z.object({
    result: z.literal("clinic_selection_required"),
    clinics: z.array(z.object({ id: uuidSchema, name: z.string() })),
  }),
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const passwordResetRequestSchema = z.object({
  email: emailSchema,
});
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(20).max(500),
  password: passwordSchema,
});
export type PasswordResetConfirm = z.infer<typeof passwordResetConfirmSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});
export type ChangePassword = z.infer<typeof changePasswordSchema>;

export const mfaEnrollResponseSchema = z.object({
  /** Base32 secret to store in the authenticator app. Shown once. */
  secret: z.string(),
  /** `otpauth://` URI for the QR code. */
  otpauthUrl: z.string(),
});
export type MfaEnrollResponse = z.infer<typeof mfaEnrollResponseSchema>;

export const mfaConfirmSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});
export type MfaConfirm = z.infer<typeof mfaConfirmSchema>;

export const mfaConfirmResponseSchema = z.object({
  /** One-time recovery codes. Displayed once, stored hashed. */
  recoveryCodes: z.array(z.string()),
});
export type MfaConfirmResponse = z.infer<typeof mfaConfirmResponseSchema>;

export const inviteUserSchema = z.object({
  email: emailSchema,
  fullName: personNameField(200),
  role: z.enum(USER_ROLES),
  branchIds: z.array(uuidSchema).default([]),
});
export type InviteUser = z.infer<typeof inviteUserSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(500),
  fullName: personNameField(200),
  password: passwordSchema,
});
export type AcceptInvite = z.infer<typeof acceptInviteSchema>;

export const updateUserSchema = z.object({
  fullName: shortText(200).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  branchIds: z.array(uuidSchema).optional(),
  /** Capability overrides from GRANTABLE_CAPABILITIES, e.g. export for front desk. */
  grantedCapabilities: z.array(z.enum(CAPABILITIES)).optional(),
});
export type UpdateUser = z.infer<typeof updateUserSchema>;

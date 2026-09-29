/**
 * Create a real clinic (tenant) and its first admin. Used by
 * `pnpm db:create-clinic` in production, where the demo seed refuses to run.
 *
 * The admin gets an invitation link, never a password chosen here: the
 * operator running the script never learns the clinic's credentials, and the
 * link expires. Everything happens in one transaction, so a failure leaves
 * nothing half-created.
 */
import { eq } from "drizzle-orm";
import { DEFAULT_PIPELINE, REASON_REQUIRED_STAGE_CATEGORIES, normalizeEmail } from "@skincrm/contracts";
import { generateToken } from "@skincrm/security";
import type { Database } from "./client";
import { auditEvents, authTokens, branches, clinics, pipelineStages, userBranches, users } from "./schema/index";

export const INVITE_TTL_DAYS = 7;

export interface ProvisionClinicInput {
  name: string;
  slug: string;
  timezone: string;
  country: string;
  branchName: string;
  adminEmail: string;
  adminName: string;
  postalAddress?: string;
  supportEmail?: string;
}

export interface ProvisionedClinic {
  clinicId: string;
  branchId: string;
  adminUserId: string;
  /** Shown once. Only its hash is stored. */
  inviteToken: string;
  inviteExpiresAt: Date;
}

export function validateProvisionInput(input: ProvisionClinicInput): string[] {
  const problems: string[] = [];
  if (!input.name.trim()) problems.push("--name is required");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug)) problems.push("--slug must be lowercase letters, digits and dashes (e.g. bright-skin-miami)");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    problems.push(`--timezone "${input.timezone}" is not an IANA time zone (e.g. America/New_York)`);
  }
  if (!/^[A-Z]{2}$/.test(input.country)) problems.push("--country must be a two-letter code (e.g. US)");
  if (!input.branchName.trim()) problems.push("--branch is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.adminEmail.trim())) problems.push("--admin-email is not a valid email address");
  if (!input.adminName.trim()) problems.push("--admin-name is required");
  return problems;
}

export async function provisionClinic(db: Database, input: ProvisionClinicInput): Promise<ProvisionedClinic> {
  const problems = validateProvisionInput(input);
  if (problems.length) throw new Error(`Cannot create clinic:\n  - ${problems.join("\n  - ")}`);
  const adminEmail = normalizeEmail(input.adminEmail)!;

  return db.transaction(async (tx) => {
    const taken = await tx.select({ id: clinics.id }).from(clinics).where(eq(clinics.slug, input.slug)).limit(1);
    if (taken[0]) throw new Error(`A clinic with slug "${input.slug}" already exists.`);

    const [clinic] = await tx
      .insert(clinics)
      .values({
        slug: input.slug,
        name: input.name.trim(),
        timezone: input.timezone,
        country: input.country,
        postalAddress: input.postalAddress ?? null,
        supportEmail: input.supportEmail ?? adminEmail,
        // Off until the clinic approves promotional copy and legal basis (PRD 4.4).
        promotionalSendingApproved: false,
        hipaaStatus: "undetermined",
      })
      .returning({ id: clinics.id });
    const clinicId = clinic!.id;

    const [branch] = await tx
      .insert(branches)
      .values({ clinicId, name: input.branchName.trim(), isDefault: true })
      .returning({ id: branches.id });

    await tx.insert(pipelineStages).values(
      DEFAULT_PIPELINE.map((stage, index) => ({
        clinicId,
        category: stage.category,
        name: stage.name,
        position: index,
        isClosed: stage.isClosed,
        requiresReason: REASON_REQUIRED_STAGE_CATEGORIES.includes(stage.category),
      })),
    );

    const [admin] = await tx
      .insert(users)
      .values({ clinicId, email: adminEmail, fullName: input.adminName.trim(), role: "admin", status: "invited", passwordHash: null })
      .returning({ id: users.id });
    await tx.insert(userBranches).values({ clinicId, userId: admin!.id, branchId: branch!.id });

    const { token, tokenHash } = generateToken(32);
    const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    await tx.insert(authTokens).values({ clinicId, userId: admin!.id, purpose: "invite", tokenHash, expiresAt: inviteExpiresAt });

    await tx.insert(auditEvents).values({
      clinicId,
      actorLabel: "system",
      action: "user_invited",
      entityType: "user",
      entityId: admin!.id,
      changeSummary: { role: "admin", via: "create-clinic script" },
    });

    return { clinicId, branchId: branch!.id, adminUserId: admin!.id, inviteToken: token, inviteExpiresAt };
  });
}

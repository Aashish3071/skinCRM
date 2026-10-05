import type { FastifyInstance } from "fastify";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { timezoneSchema, uuidSchema } from "@skincrm/contracts";
import { schema } from "@skincrm/db";
import { getContext, getTx } from "../context";
import { registerRoute } from "../route";
import { badRequest, conflict, notFound } from "../errors";
import { recordAudit } from "../audit";
const { branches, pipelineStages, clinics, appointments, workingHours } =
  schema;
const branchInput = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: timezoneSchema.nullable().default(null),
  city: z.string().trim().max(120).nullable().default(null),
  addressLine1: z.string().trim().max(250).nullable().default(null),
  isDefault: z.boolean().default(false),
});
export function registerCrmSettingsRoutes(app: FastifyInstance) {
  registerRoute(app, {
    method: "GET",
    url: "/settings/branches",
    auth: { capability: "settings:read" },
    handler: async () => ({
      items: await getTx()
        .select()
        .from(branches)
        .where(isNull(branches.archivedAt))
        .orderBy(asc(branches.name)),
    }),
  });
  for (const method of ["POST", "PATCH"] as const)
    registerRoute(app, {
      method,
      url: method === "POST" ? "/settings/branches" : "/settings/branches/:id",
      auth: { capability: "settings:write" },
      params: z.object({ id: uuidSchema.optional() }),
      body: branchInput,
      handler: async ({ body, params }) => {
        const tx = getTx();
        const clinicId = getContext().clinicId!;
        await tx
          .select({ id: clinics.id })
          .from(clinics)
          .where(eq(clinics.id, clinicId))
          .for("update");
        const rows = await tx
          .select()
          .from(branches)
          .where(isNull(branches.archivedAt));
        if (method === "PATCH" && !rows.some((r) => r.id === params.id))
          throw notFound("No such branch.");
        if (
          rows.some(
            (r) =>
              r.id !== params.id &&
              r.name.toLowerCase() === body.name.toLowerCase(),
          )
        )
          throw conflict("A branch already uses that name.");
        const wasDefault = rows.find((r) => r.id === params.id)?.isDefault;
        if (wasDefault && !body.isDefault)
          throw badRequest("Make another branch the default first.");
        const value = {
          ...body,
          isDefault: body.isDefault || rows.length === 0,
          updatedAt: new Date(),
        };
        if (value.isDefault)
          await tx
            .update(branches)
            .set({ isDefault: false })
            .where(eq(branches.clinicId, clinicId));
        const [row] =
          method === "POST"
            ? await tx
                .insert(branches)
                .values({ ...value, clinicId })
                .returning()
            : await tx
                .update(branches)
                .set(value)
                .where(eq(branches.id, params.id!))
                .returning();
        await recordAudit({
          action: method === "POST" ? "record_created" : "record_updated",
          entityType: "branch",
          entityId: row!.id,
          changeSummary: { name: row!.name },
        });
        return row;
      },
    });
  registerRoute(app, {
    method: "DELETE",
    url: "/settings/branches/:id",
    auth: { capability: "settings:write" },
    params: z.object({ id: uuidSchema }),
    handler: async ({ params }) => {
      const tx = getTx();
      await tx
        .select({ id: clinics.id })
        .from(clinics)
        .where(eq(clinics.id, getContext().clinicId!))
        .for("update");
      const [branch] = await tx
        .select()
        .from(branches)
        .where(and(eq(branches.id, params.id), isNull(branches.archivedAt)));
      if (!branch) throw notFound("No such branch.");
      if (branch.isDefault)
        throw badRequest(
          "Choose another default branch before archiving this one.",
        );
      const upcoming = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.branchId, params.id),
            gt(appointments.endsAt, new Date()),
            inArray(appointments.status, ["scheduled", "confirmed"]),
          ),
        );
      if (upcoming.length)
        throw conflict(
          "Move or cancel this branch's upcoming appointments first.",
        );
      await tx.delete(workingHours).where(eq(workingHours.branchId, params.id));
      await tx
        .update(branches)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(branches.id, params.id));
      await recordAudit({
        action: "record_updated",
        entityType: "branch",
        entityId: params.id,
        changeSummary: { archived: true },
      });
      return { ok: true };
    },
  });
  registerRoute(app, {
    method: "PUT",
    url: "/settings/pipeline",
    auth: { capability: "settings:write" },
    body: z.object({
      stages: z
        .array(
          z.object({ id: uuidSchema, name: z.string().trim().min(1).max(100) }),
        )
        .min(1)
        .max(30),
    }),
    handler: async ({ body }) => {
      const tx = getTx();
      await tx
        .select({ id: clinics.id })
        .from(clinics)
        .where(eq(clinics.id, getContext().clinicId!))
        .for("update");
      const current = await tx
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.isActive, true));
      if (
        body.stages.length !== current.length ||
        new Set(body.stages.map((s) => s.id)).size !== current.length ||
        body.stages.some((s) => !current.some((c) => c.id === s.id))
      )
        throw badRequest(
          "Include every current stage exactly once. Refresh the page.",
        );
      if (
        new Set(body.stages.map((s) => s.name.toLowerCase())).size !==
        body.stages.length
      )
        throw badRequest("Each stage needs a different name.");
      for (const [position, stage] of body.stages.entries())
        await tx
          .update(pipelineStages)
          .set({ name: stage.name, position, updatedAt: new Date() })
          .where(eq(pipelineStages.id, stage.id));
      await recordAudit({
        action: "record_updated",
        entityType: "pipeline_settings",
        changeSummary: { stages: body.stages },
      });
      return { ok: true };
    },
  });
}

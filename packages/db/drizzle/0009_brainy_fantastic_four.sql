ALTER TABLE "clinics" ADD COLUMN "first_response_sla_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "sla_escalation_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "first_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "sla_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "sla_breached_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "leads_sla_due_idx" ON "leads" USING btree ("sla_due_at") WHERE "leads"."first_response_at" is null and "leads"."sla_breached_at" is null;
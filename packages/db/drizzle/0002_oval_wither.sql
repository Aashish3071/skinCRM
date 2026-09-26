CREATE TABLE "assignment_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"match_source" "lead_source",
	"match_service_interest" text,
	"match_branch_id" uuid,
	"assign_mode" text DEFAULT 'user' NOT NULL,
	"assign_user_id" uuid,
	"pool_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_assigned_user_id" uuid,
	"last_matched_at" timestamp with time zone,
	"match_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_match_branch_id_branches_id_fk" FOREIGN KEY ("match_branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_assign_user_id_users_id_fk" FOREIGN KEY ("assign_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_last_assigned_user_id_users_id_fk" FOREIGN KEY ("last_assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_rules_clinic_priority_key" ON "assignment_rules" USING btree ("clinic_id","priority");--> statement-breakpoint
CREATE INDEX "assignment_rules_clinic_active_idx" ON "assignment_rules" USING btree ("clinic_id","is_active");
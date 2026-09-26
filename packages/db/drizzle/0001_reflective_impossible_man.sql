CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" "contact_channel" NOT NULL,
	"purpose" "consent_purpose" NOT NULL,
	"status" "consent_status" NOT NULL,
	"source" "consent_source" NOT NULL,
	"notice_version" text,
	"evidence_reference" text,
	"captured_text" text,
	"recorded_by_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "general_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"author_user_id" uuid,
	"author_label" text,
	"edited_at" timestamp with time zone,
	"edited_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"display_name" text NOT NULL,
	"phone_raw" text,
	"phone_e164" text,
	"phone_country" text,
	"phone_valid" boolean DEFAULT false NOT NULL,
	"email_raw" text,
	"email_normalized" text,
	"preferred_contact_method" "contact_channel",
	"preferred_language" text,
	"branch_id" uuid,
	"date_of_birth" date,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"merged_into_person_id" uuid,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"surviving_person_id" uuid NOT NULL,
	"merged_person_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone,
	"reverted_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"lead_id" uuid,
	"type" "activity_type" NOT NULL,
	"summary" text NOT NULL,
	"body" text,
	"outcome" text,
	"actor_user_id" uuid,
	"actor_label" text,
	"entity_type" text,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_stage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"source_submission_id" uuid,
	"source" "lead_source" NOT NULL,
	"reporting_source" "lead_source",
	"stage_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"branch_id" uuid,
	"service_interest" text,
	"inquiry_note" text,
	"first_contacted_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"qualified_by_user_id" uuid,
	"booked_at" timestamp with time zone,
	"attended_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"loss_reason" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "raw_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"platform" "source_platform" NOT NULL,
	"encrypted_payload" text NOT NULL,
	"fingerprint" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"platform" "source_platform" NOT NULL,
	"external_id" text,
	"source" "lead_source" NOT NULL,
	"submitted_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" text,
	"campaign_id" text,
	"campaign_name" text,
	"adset_id" text,
	"ad_id" text,
	"form_id" text,
	"form_name" text,
	"click_id" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"referral_id" text,
	"normalized_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_payload_id" uuid,
	"payload_fingerprint" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"ingest_status" "ingest_status" DEFAULT 'received' NOT NULL,
	"ingest_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"correlation_id" text,
	"person_id" uuid,
	"lead_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"lead_id" uuid,
	"person_id" uuid,
	"title" text NOT NULL,
	"detail" text,
	"owner_user_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"outcome" "task_outcome",
	"outcome_note" text,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" uuid,
	"snoozed_from" timestamp with time zone,
	"created_by_rule_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_notes" ADD CONSTRAINT "general_notes_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_notes" ADD CONSTRAINT "general_notes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_notes" ADD CONSTRAINT "general_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_notes" ADD CONSTRAINT "general_notes_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_surviving_person_id_people_id_fk" FOREIGN KEY ("surviving_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_merged_person_id_people_id_fk" FOREIGN KEY ("merged_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_reverted_by_user_id_users_id_fk" FOREIGN KEY ("reverted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_events" ADD CONSTRAINT "lead_stage_events_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_events" ADD CONSTRAINT "lead_stage_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_events" ADD CONSTRAINT "lead_stage_events_from_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_events" ADD CONSTRAINT "lead_stage_events_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_events" ADD CONSTRAINT "lead_stage_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_submission_id_source_submissions_id_fk" FOREIGN KEY ("source_submission_id") REFERENCES "public"."source_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_qualified_by_user_id_users_id_fk" FOREIGN KEY ("qualified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_payloads" ADD CONSTRAINT "raw_payloads_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_submissions" ADD CONSTRAINT "source_submissions_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_submissions" ADD CONSTRAINT "source_submissions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_person_channel_purpose_idx" ON "consent_records" USING btree ("person_id","channel","purpose","occurred_at");--> statement-breakpoint
CREATE INDEX "consent_clinic_idx" ON "consent_records" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "general_notes_person_idx" ON "general_notes" USING btree ("person_id","pinned","created_at");--> statement-breakpoint
CREATE INDEX "general_notes_clinic_idx" ON "general_notes" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "people_clinic_phone_idx" ON "people" USING btree ("clinic_id","phone_e164");--> statement-breakpoint
CREATE INDEX "people_clinic_email_idx" ON "people" USING btree ("clinic_id","email_normalized");--> statement-breakpoint
CREATE INDEX "people_clinic_created_idx" ON "people" USING btree ("clinic_id","created_at");--> statement-breakpoint
CREATE INDEX "people_merged_into_idx" ON "people" USING btree ("merged_into_person_id");--> statement-breakpoint
CREATE INDEX "person_merges_surviving_idx" ON "person_merges" USING btree ("surviving_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_merges_merged_active_key" ON "person_merges" USING btree ("merged_person_id","reverted_at");--> statement-breakpoint
CREATE INDEX "activities_lead_idx" ON "activities" USING btree ("lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activities_person_idx" ON "activities" USING btree ("person_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activities_clinic_type_idx" ON "activities" USING btree ("clinic_id","type");--> statement-breakpoint
CREATE INDEX "lead_stage_events_lead_idx" ON "lead_stage_events" USING btree ("lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX "leads_clinic_stage_idx" ON "leads" USING btree ("clinic_id","stage_id");--> statement-breakpoint
CREATE INDEX "leads_clinic_owner_idx" ON "leads" USING btree ("clinic_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "leads_person_idx" ON "leads" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "leads_clinic_created_idx" ON "leads" USING btree ("clinic_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_clinic_source_idx" ON "leads" USING btree ("clinic_id","source");--> statement-breakpoint
CREATE INDEX "raw_payloads_clinic_received_idx" ON "raw_payloads" USING btree ("clinic_id","received_at");--> statement-breakpoint
CREATE INDEX "raw_payloads_retention_idx" ON "raw_payloads" USING btree ("retention_until");--> statement-breakpoint
CREATE UNIQUE INDEX "source_submissions_external_key" ON "source_submissions" USING btree ("clinic_id","platform","external_id") WHERE "source_submissions"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "source_submissions_clinic_received_idx" ON "source_submissions" USING btree ("clinic_id","received_at");--> statement-breakpoint
CREATE INDEX "source_submissions_status_idx" ON "source_submissions" USING btree ("clinic_id","ingest_status");--> statement-breakpoint
CREATE INDEX "source_submissions_person_idx" ON "source_submissions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "tasks_owner_due_idx" ON "tasks" USING btree ("clinic_id","owner_user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_lead_idx" ON "tasks" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "tasks_clinic_due_idx" ON "tasks" USING btree ("clinic_id","due_at");
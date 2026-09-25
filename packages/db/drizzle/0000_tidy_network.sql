CREATE TYPE "public"."activity_type" AS ENUM('note', 'call', 'email_sent', 'email_received', 'whatsapp_sent', 'whatsapp_received', 'stage_change', 'assignment_change', 'task_created', 'task_completed', 'appointment_created', 'appointment_changed', 'consent_change', 'automation_event', 'source_submission', 'merge', 'conversion_feedback', 'system');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'confirmed', 'attended', 'no_show', 'canceled', 'rescheduled');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('login_success', 'login_failure', 'logout', 'password_reset_requested', 'password_reset_completed', 'mfa_enabled', 'mfa_disabled', 'user_invited', 'user_role_changed', 'user_suspended', 'record_created', 'record_updated', 'record_deleted', 'sensitive_record_viewed', 'note_edited', 'note_archived', 'person_merged', 'person_merge_reverted', 'consent_changed', 'export_generated', 'automation_rule_changed', 'template_changed', 'integration_connected', 'integration_disconnected', 'integration_credentials_revoked', 'feedback_mapping_changed', 'feedback_paused', 'settings_changed', 'event_replayed');--> statement-breakpoint
CREATE TYPE "public"."consent_purpose" AS ENUM('operational', 'promotional');--> statement-breakpoint
CREATE TYPE "public"."consent_source" AS ENUM('web_form', 'walk_in_form', 'verbal_staff_recorded', 'whatsapp_inbound', 'ad_platform_form', 'csv_import', 'unsubscribe_link', 'staff_override');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('granted', 'denied', 'withdrawn', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."contact_attempt_outcome" AS ENUM('attempted', 'connected', 'no_answer', 'invalid_contact');--> statement-breakpoint
CREATE TYPE "public"."contact_channel" AS ENUM('email', 'whatsapp', 'phone', 'sms');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'pending', 'resolved', 'snoozed');--> statement-breakpoint
CREATE TYPE "public"."feedback_destination" AS ENUM('meta', 'google');--> statement-breakpoint
CREATE TYPE "public"."feedback_eligibility_state" AS ENUM('unreviewed', 'blocked_by_policy', 'pending_clinic_approval', 'approved_test_only', 'approved_production');--> statement-breakpoint
CREATE TYPE "public"."feedback_event_state" AS ENUM('candidate', 'blocked', 'queued', 'sending', 'sent', 'accepted', 'rejected', 'unmatched', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."feedback_match_key" AS ENUM('meta_lead_id', 'meta_whatsapp_referral_id', 'google_click_id', 'google_lead_id');--> statement-breakpoint
CREATE TYPE "public"."feedback_milestone" AS ENUM('qualified', 'consultation_booked', 'consultation_attended', 'converted');--> statement-breakpoint
CREATE TYPE "public"."ingest_status" AS ENUM('received', 'processing', 'processed', 'failed', 'dead_letter', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."integration_health_state" AS ENUM('not_configured', 'connecting', 'healthy', 'degraded', 'disconnected', 'error');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('meta_lead_ads', 'meta_conversions_api', 'whatsapp_cloud', 'google_lead_forms', 'google_data_manager', 'email', 'calendar');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('walk_in', 'phone', 'website_form', 'csv_import', 'meta_lead_ad', 'google_lead_form', 'whatsapp_ad', 'whatsapp_organic', 'referral', 'manual', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."message_delivery_state" AS ENUM('draft', 'scheduled', 'queued', 'sending', 'sent', 'delivered', 'read', 'bounced', 'failed', 'canceled', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."source_platform" AS ENUM('meta', 'google', 'whatsapp', 'website', 'csv', 'internal');--> statement-breakpoint
CREATE TYPE "public"."stage_category" AS ENUM('new', 'attempting_contact', 'connected', 'qualified', 'consultation_booked', 'consultation_attended', 'converted', 'nurture', 'lost', 'unqualified', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('no_consent', 'opted_out', 'frequency_cap', 'quiet_hours', 'outside_service_window', 'template_not_approved', 'missing_contact_detail', 'lead_closed', 'appointment_changed', 'stop_condition_met', 'global_sending_disabled', 'provider_paused', 'duplicate_idempotency_key');--> statement-breakpoint
CREATE TYPE "public"."task_outcome" AS ENUM('connected', 'no_answer', 'left_voicemail', 'invalid_contact', 'not_interested', 'booked', 'rescheduled', 'other');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'snoozed', 'completed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."template_classification" AS ENUM('operational', 'promotional');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'front_desk', 'practitioner', 'marketing_analyst');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_message_type" AS ENUM('text', 'template', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'contacts', 'interactive', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_template_status" AS ENUM('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"change_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"correlation_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"user_id" uuid,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"phone" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clinics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"postal_address" text,
	"support_email" text,
	"sending_domain" text,
	"first_contact_sla_minutes" integer DEFAULT 60 NOT NULL,
	"quiet_hours_start" text DEFAULT '21:00' NOT NULL,
	"quiet_hours_end" text DEFAULT '08:00' NOT NULL,
	"promotional_sending_approved" boolean DEFAULT false NOT NULL,
	"promotional_sending_approved_at" timestamp with time zone,
	"hipaa_status" text DEFAULT 'undetermined' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"category" "stage_category" NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"requires_reason" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"session_epoch" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"mfa_secret_encrypted" text,
	"mfa_enabled_at" timestamp with time zone,
	"granted_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_branches" ADD CONSTRAINT "user_branches_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_branches" ADD CONSTRAINT "user_branches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_branches" ADD CONSTRAINT "user_branches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_clinic_occurred_idx" ON "audit_events" USING btree ("clinic_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_purpose_idx" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "branches_clinic_idx" ON "branches" USING btree ("clinic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinics_slug_key" ON "clinics" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_user_idx" ON "mfa_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_clinic_category_key" ON "pipeline_stages" USING btree ("clinic_id","category");--> statement-breakpoint
CREATE INDEX "pipeline_stages_clinic_position_idx" ON "pipeline_stages" USING btree ("clinic_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_branches_user_branch_key" ON "user_branches" USING btree ("user_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_clinic_email_key" ON "users" USING btree ("clinic_id","email");--> statement-breakpoint
CREATE INDEX "users_clinic_role_idx" ON "users" USING btree ("clinic_id","role");
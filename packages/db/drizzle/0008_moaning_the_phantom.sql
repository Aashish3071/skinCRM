CREATE TYPE "public"."inbound_event_state" AS ENUM('pending', 'processed', 'failed', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."inbound_event_type" AS ENUM('meta_leadgen', 'google_lead', 'whatsapp_message', 'whatsapp_status');--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"connection_id" uuid,
	"type" "inbound_event_type" NOT NULL,
	"external_id" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"is_test" integer DEFAULT 0 NOT NULL,
	"state" "inbound_event_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"result" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"status" "integration_health_state" DEFAULT 'connecting' NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_secret" text,
	"last_event_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"connected_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_external_key" ON "inbound_events" USING btree ("clinic_id","type","external_id");--> statement-breakpoint
CREATE INDEX "inbound_events_due_idx" ON "inbound_events" USING btree ("next_attempt_at") WHERE "inbound_events"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "inbound_events_clinic_idx" ON "inbound_events" USING btree ("clinic_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_account_key" ON "integration_connections" USING btree ("provider","external_account_id");--> statement-breakpoint
CREATE INDEX "integration_connections_clinic_idx" ON "integration_connections" USING btree ("clinic_id","provider");
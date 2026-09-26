CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"channel" "contact_channel" NOT NULL,
	"classification" "template_classification" NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"allowed_variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"whatsapp_template_name" text,
	"whatsapp_language_code" text DEFAULT 'en',
	"whatsapp_status" "whatsapp_template_status",
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"lead_id" uuid,
	"channel" "contact_channel" NOT NULL,
	"direction" "message_direction" DEFAULT 'outbound' NOT NULL,
	"classification" "template_classification" NOT NULL,
	"template_id" uuid,
	"template_version" integer,
	"recipient" text,
	"rendered_subject" text,
	"rendered_body" text,
	"state" "message_delivery_state" DEFAULT 'draft' NOT NULL,
	"suppression_reason" "suppression_reason",
	"failure_detail" text,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"rule_id" uuid,
	"triggered_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"person_id" uuid,
	"channel" "contact_channel" NOT NULL,
	"destination" text NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"detail" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_template_id_message_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_clinic_key" ON "message_templates" USING btree ("clinic_id","key");--> statement-breakpoint
CREATE INDEX "message_templates_clinic_channel_idx" ON "message_templates" USING btree ("clinic_id","channel","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency_key" ON "messages" USING btree ("clinic_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "messages_person_idx" ON "messages" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_clinic_state_idx" ON "messages" USING btree ("clinic_id","state");--> statement-breakpoint
CREATE INDEX "messages_scheduled_idx" ON "messages" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "messages_provider_idx" ON "messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_destination_key" ON "suppressions" USING btree ("clinic_id","channel","destination");--> statement-breakpoint
CREATE INDEX "suppressions_person_idx" ON "suppressions" USING btree ("person_id");
CREATE TABLE "feedback_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"destination" "feedback_destination" NOT NULL,
	"eligibility" "feedback_eligibility_state" DEFAULT 'unreviewed' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"mapping" jsonb NOT NULL,
	"mapping_version" integer DEFAULT 1 NOT NULL,
	"include_whatsapp_ads" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_secret" text,
	"checklist_confirmed_by" uuid,
	"checklist_confirmed_at" timestamp with time zone,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"destination" "feedback_destination" NOT NULL,
	"lead_id" uuid NOT NULL,
	"milestone" "feedback_milestone" NOT NULL,
	"event_id" text NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"match_key" text,
	"match_value" text,
	"mapping_version" integer NOT NULL,
	"state" "feedback_event_state" DEFAULT 'queued' NOT NULL,
	"reason" text,
	"test_mode" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"provider_response" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_destinations" ADD CONSTRAINT "feedback_destinations_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_destinations" ADD CONSTRAINT "feedback_destinations_checklist_confirmed_by_users_id_fk" FOREIGN KEY ("checklist_confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_destinations_clinic_key" ON "feedback_destinations" USING btree ("clinic_id","destination");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_events_candidate_key" ON "feedback_events" USING btree ("clinic_id","destination","lead_id","milestone");--> statement-breakpoint
CREATE INDEX "feedback_events_due_idx" ON "feedback_events" USING btree ("next_attempt_at") WHERE "feedback_events"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "feedback_events_clinic_idx" ON "feedback_events" USING btree ("clinic_id","created_at");
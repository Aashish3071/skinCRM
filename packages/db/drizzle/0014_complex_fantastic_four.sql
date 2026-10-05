CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'uncertain' NOT NULL,
	"provider_message_id" text,
	"accepted_at" timestamp with time zone,
	"detail" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"permanent_suppression" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_key" ON "delivery_attempts" USING btree ("clinic_id","idempotency_key");
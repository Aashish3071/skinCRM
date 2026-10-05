ALTER TYPE "public"."lead_source" ADD VALUE 'online_booking';--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "online_booking_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "booking_change_cutoff_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "consultation_types" ADD COLUMN "bookable_online" boolean DEFAULT false NOT NULL;
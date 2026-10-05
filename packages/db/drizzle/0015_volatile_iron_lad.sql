ALTER TABLE "activities" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TYPE "public"."inbound_event_type" ADD VALUE 'email_inbound';--> statement-breakpoint
ALTER TYPE "public"."inbound_event_type" ADD VALUE 'email_event';--> statement-breakpoint
ALTER TYPE "public"."suppression_reason" ADD VALUE 'hard_bounce';--> statement-breakpoint
ALTER TYPE "public"."suppression_reason" ADD VALUE 'spam_complaint';
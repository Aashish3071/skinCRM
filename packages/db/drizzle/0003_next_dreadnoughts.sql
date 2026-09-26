ALTER TABLE "clinics" ADD COLUMN "website_form_key_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "clinics_website_form_key_idx" ON "clinics" USING btree ("website_form_key_hash");
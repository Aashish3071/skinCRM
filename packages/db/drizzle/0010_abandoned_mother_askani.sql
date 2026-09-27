CREATE TABLE "ops_heartbeats" (
	"key" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" text
);

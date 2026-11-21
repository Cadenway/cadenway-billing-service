CREATE TABLE "usage_generations" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"seats" bigint DEFAULT 0 NOT NULL,
	"guests" bigint DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"membership_cursor" text,
	"membership_scan_complete" boolean DEFAULT false NOT NULL,
	"attachment_cursor" text,
	"attachment_scan_complete" boolean DEFAULT false NOT NULL,
	"checkpoint_version" integer DEFAULT 1 NOT NULL,
	"stream_checkpoint" jsonb,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_generations_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "usage_generations_status_check" CHECK ("usage_generations"."status" in ('building', 'ready', 'invalid')),
	CONSTRAINT "usage_generations_seats_check" CHECK ("usage_generations"."seats" between 0 and 9007199254740991),
	CONSTRAINT "usage_generations_guests_check" CHECK ("usage_generations"."guests" between 0 and 9007199254740991),
	CONSTRAINT "usage_generations_storage_bytes_check" CHECK ("usage_generations"."storage_bytes" between 0 and 9007199254740991),
	CONSTRAINT "usage_generations_checkpoint_version_check" CHECK ("usage_generations"."checkpoint_version" > 0),
	CONSTRAINT "usage_generations_checkpoint_object_check" CHECK ("usage_generations"."stream_checkpoint" is null or jsonb_typeof("usage_generations"."stream_checkpoint") = 'object'),
	CONSTRAINT "usage_generations_ready_checkpoint_check" CHECK ("usage_generations"."status" <> 'ready' or ("usage_generations"."membership_scan_complete" and "usage_generations"."attachment_scan_complete" and "usage_generations"."stream_checkpoint" is not null)),
	CONSTRAINT "usage_generations_membership_cursor_check" CHECK ("usage_generations"."membership_cursor" is null or length("usage_generations"."membership_cursor") between 1 and 1024),
	CONSTRAINT "usage_generations_attachment_cursor_check" CHECK ("usage_generations"."attachment_cursor" is null or length("usage_generations"."attachment_cursor") between 1 and 1024),
	CONSTRAINT "usage_generations_version_check" CHECK ("usage_generations"."version" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "usage_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "usage_observations" (
	"organization_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_version" bigint NOT NULL,
	"state" text NOT NULL,
	"membership_role" text,
	"attachment_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_observations_organization_id_generation_id_source_source_id_pk" PRIMARY KEY("organization_id","generation_id","source","source_id"),
	CONSTRAINT "usage_observations_source_version_check" CHECK ("usage_observations"."source_version" between 1 and 9007199254740991),
	CONSTRAINT "usage_observations_shape_check" CHECK (("usage_observations"."source" = 'membership' and "usage_observations"."state" = 'present' and "usage_observations"."membership_role" is not null and "usage_observations"."membership_role" in ('owner', 'admin', 'member', 'guest') and "usage_observations"."attachment_bytes" is null) or ("usage_observations"."source" = 'attachment' and "usage_observations"."state" = 'present' and "usage_observations"."membership_role" is null and "usage_observations"."attachment_bytes" is not null and "usage_observations"."attachment_bytes" between 1 and 26214400) or ("usage_observations"."source" in ('membership', 'attachment') and "usage_observations"."state" = 'absent' and "usage_observations"."membership_role" is null and "usage_observations"."attachment_bytes" is null))
);
--> statement-breakpoint
ALTER TABLE "usage_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "usage_organizations" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"active_generation_id" uuid,
	"candidate_generation_id" uuid,
	"seats_event_version" bigint DEFAULT 0 NOT NULL,
	"storage_event_version" bigint DEFAULT 0 NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_organizations_seats_event_version_check" CHECK ("usage_organizations"."seats_event_version" between 0 and 9007199254740991),
	CONSTRAINT "usage_organizations_storage_event_version_check" CHECK ("usage_organizations"."storage_event_version" between 0 and 9007199254740991),
	CONSTRAINT "usage_organizations_version_check" CHECK ("usage_organizations"."version" between 1 and 9007199254740991),
	CONSTRAINT "usage_organizations_generations_distinct_check" CHECK ("usage_organizations"."active_generation_id" is null or "usage_organizations"."candidate_generation_id" is null or "usage_organizations"."active_generation_id" <> "usage_organizations"."candidate_generation_id")
);
--> statement-breakpoint
ALTER TABLE "usage_organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_generations" ADD CONSTRAINT "usage_generations_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."usage_organizations"("organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_observations" ADD CONSTRAINT "usage_observations_generation_fk" FOREIGN KEY ("organization_id","generation_id") REFERENCES "public"."usage_generations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "usage_generations_tenant_isolation" ON "usage_generations" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "usage_observations_tenant_isolation" ON "usage_observations" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "usage_organizations_tenant_isolation" ON "usage_organizations" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
-- Drizzle enables RLS but does not force it for table owners.
ALTER TABLE "usage_generations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_observations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_organizations" FORCE ROW LEVEL SECURITY;

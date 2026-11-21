CREATE TABLE "usage_threshold_intents" (
	"organization_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"event_version" bigint NOT NULL,
	"quota_limit" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_threshold_intents_organization_id_metric_pk" PRIMARY KEY("organization_id","metric"),
	CONSTRAINT "usage_threshold_intents_metric_check" CHECK ("usage_threshold_intents"."metric" in ('seats', 'storage')),
	CONSTRAINT "usage_threshold_intents_event_version_check" CHECK ("usage_threshold_intents"."event_version" between 1 and 9007199254740991),
	CONSTRAINT "usage_threshold_intents_quota_limit_check" CHECK ("usage_threshold_intents"."quota_limit" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "usage_threshold_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_threshold_intents" ADD CONSTRAINT "usage_threshold_intents_generation_fk" FOREIGN KEY ("organization_id","generation_id") REFERENCES "public"."usage_generations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "usage_threshold_intents_tenant_isolation" ON "usage_threshold_intents" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
-- Drizzle enables RLS but does not force it for table owners.
ALTER TABLE "usage_threshold_intents" FORCE ROW LEVEL SECURITY;

CREATE TABLE "stripe_bindings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_bindings_customer_id_check" CHECK (length("stripe_bindings"."customer_id") between 1 and 255),
	CONSTRAINT "stripe_bindings_subscription_id_check" CHECK (length("stripe_bindings"."subscription_id") between 1 and 255),
	CONSTRAINT "stripe_bindings_version_check" CHECK ("stripe_bindings"."version" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "stripe_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stripe_reconciliation_receipts" (
	"organization_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_reconciliation_receipts_organization_id_event_id_pk" PRIMARY KEY("organization_id","event_id"),
	CONSTRAINT "stripe_reconciliation_receipts_event_id_check" CHECK (length("stripe_reconciliation_receipts"."event_id") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "stripe_reconciliation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stripe_subscription_snapshots" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"seats" bigint NOT NULL,
	"storage_bytes" bigint NOT NULL,
	"scheduled_cancellation" boolean DEFAULT false NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_subscription_snapshots_plan_check" CHECK ("stripe_subscription_snapshots"."plan" in ('free', 'team')),
	CONSTRAINT "stripe_subscription_snapshots_seats_check" CHECK ("stripe_subscription_snapshots"."seats" between 0 and 9007199254740991),
	CONSTRAINT "stripe_subscription_snapshots_storage_check" CHECK ("stripe_subscription_snapshots"."storage_bytes" between 0 and 9007199254740991),
	CONSTRAINT "stripe_subscription_snapshots_version_check" CHECK ("stripe_subscription_snapshots"."version" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "stripe_subscription_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_reconciliation_receipts" ADD CONSTRAINT "stripe_reconciliation_receipts_organization_id_stripe_bindings_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."stripe_bindings"("organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_subscription_snapshots" ADD CONSTRAINT "stripe_subscription_snapshots_organization_id_stripe_bindings_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."stripe_bindings"("organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "stripe_bindings_tenant_isolation" ON "stripe_bindings" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "stripe_reconciliation_receipts_tenant_isolation" ON "stripe_reconciliation_receipts" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "stripe_subscription_snapshots_tenant_isolation" ON "stripe_subscription_snapshots" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
-- Drizzle enables RLS but does not force it for table owners.
ALTER TABLE "stripe_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_reconciliation_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stripe_subscription_snapshots" FORCE ROW LEVEL SECURITY;

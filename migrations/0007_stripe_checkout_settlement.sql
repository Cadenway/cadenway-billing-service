CREATE TABLE "stripe_checkout_receipts" (
	"organization_id" uuid NOT NULL,
	"event_id" text PRIMARY KEY NOT NULL,
	"provider_key" text NOT NULL,
	"session_id" text NOT NULL,
	"terminal_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_checkout_receipts_terminal_check" CHECK ("stripe_checkout_receipts"."terminal_status" in ('complete', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "stripe_checkout_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "stripe_checkout_receipts_reservation" ON "stripe_checkout_receipts" USING btree ("organization_id","provider_key","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_checkout_attempts_provider_key_unique" ON "stripe_checkout_attempts" USING btree ("provider_key");--> statement-breakpoint
CREATE POLICY "stripe_checkout_attempts_exact_system_lookup" ON "stripe_checkout_attempts" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'on'
        and provider_key = nullif(current_setting('app.stripe_checkout_provider_key', true), ''));--> statement-breakpoint
CREATE POLICY "stripe_checkout_receipts_tenant_isolation" ON "stripe_checkout_receipts" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stripe_checkout_receipts_exact_system_lookup" ON "stripe_checkout_receipts" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'on'
        and event_id = nullif(current_setting('app.stripe_checkout_event_id', true), ''));
--> statement-breakpoint
-- Keep receipt access scoped even when the table owner queries it.
ALTER TABLE "stripe_checkout_receipts" FORCE ROW LEVEL SECURITY;

CREATE TABLE "stripe_webhook_inbox" (
	"event_id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"session_id" text,
	"customer_id" text,
	"subscription_id" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_webhook_inbox_identity_check" CHECK ("stripe_webhook_inbox"."event_id" ~ '^[!-~]{1,255}$'
        and (
          ("stripe_webhook_inbox"."kind" = 'checkout' and "stripe_webhook_inbox"."session_id" is not null
            and "stripe_webhook_inbox"."session_id" ~ '^[!-~]{1,255}$'
            and "stripe_webhook_inbox"."customer_id" is null and "stripe_webhook_inbox"."subscription_id" is null)
          or ("stripe_webhook_inbox"."kind" = 'subscription' and "stripe_webhook_inbox"."session_id" is null
            and "stripe_webhook_inbox"."customer_id" is not null and "stripe_webhook_inbox"."subscription_id" is not null
            and "stripe_webhook_inbox"."customer_id" ~ '^[!-~]{1,255}$'
            and "stripe_webhook_inbox"."subscription_id" ~ '^[!-~]{1,255}$')
        )),
	CONSTRAINT "stripe_webhook_inbox_claim_count_check" CHECK ("stripe_webhook_inbox"."claim_count" between 0 and 1000000),
	CONSTRAINT "stripe_webhook_inbox_finished_check" CHECK ("stripe_webhook_inbox"."finished_at" is null or "stripe_webhook_inbox"."lease_token" is null)
);
--> statement-breakpoint
ALTER TABLE "stripe_webhook_inbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "stripe_webhook_inbox_pending" ON "stripe_webhook_inbox" USING btree ("available_at","event_id") WHERE "stripe_webhook_inbox"."finished_at" is null;--> statement-breakpoint
CREATE POLICY "stripe_webhook_inbox_tenant_isolation" ON "stripe_webhook_inbox" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stripe_webhook_inbox_worker_select" ON "stripe_webhook_inbox" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'on'
        and current_setting('app.stripe_webhook_inbox_work', true) = 'on'
        and finished_at is null);--> statement-breakpoint
CREATE POLICY "stripe_webhook_inbox_worker_update" ON "stripe_webhook_inbox" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.system_access', true) = 'on'
        and current_setting('app.stripe_webhook_inbox_work', true) = 'on'
        and finished_at is null) WITH CHECK (current_setting('app.system_access', true) = 'on'
        and current_setting('app.stripe_webhook_inbox_work', true) = 'on'
        and finished_at is null);
--> statement-breakpoint
ALTER TABLE "stripe_webhook_inbox" FORCE ROW LEVEL SECURITY;

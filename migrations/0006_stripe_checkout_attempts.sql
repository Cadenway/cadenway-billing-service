CREATE TABLE "stripe_checkout_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"key_digest" text NOT NULL,
	"plan" text NOT NULL,
	"provider_key" text NOT NULL,
	"price_id" text,
	"quantity" bigint,
	"success_url" text,
	"cancel_url" text,
	"provider_started_at" timestamp with time zone,
	"response_url" text,
	"completed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "stripe_checkout_attempts_key_digest_check" CHECK ("stripe_checkout_attempts"."key_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "stripe_checkout_attempts_plan_check" CHECK ("stripe_checkout_attempts"."plan" = 'team'),
	CONSTRAINT "stripe_checkout_attempts_version_check" CHECK ("stripe_checkout_attempts"."version" between 1 and 9007199254740991),
	CONSTRAINT "stripe_checkout_attempts_lease_check" CHECK (("stripe_checkout_attempts"."lease_token" is null) = ("stripe_checkout_attempts"."lease_expires_at" is null)),
	CONSTRAINT "stripe_checkout_attempts_request_check" CHECK (("stripe_checkout_attempts"."provider_started_at" is null and "stripe_checkout_attempts"."price_id" is null and "stripe_checkout_attempts"."quantity" is null and "stripe_checkout_attempts"."success_url" is null and "stripe_checkout_attempts"."cancel_url" is null)
        or ("stripe_checkout_attempts"."provider_started_at" is not null and "stripe_checkout_attempts"."price_id" is not null and "stripe_checkout_attempts"."quantity" is not null and "stripe_checkout_attempts"."quantity" > 0 and "stripe_checkout_attempts"."success_url" is not null and "stripe_checkout_attempts"."cancel_url" is not null)),
	CONSTRAINT "stripe_checkout_attempts_response_check" CHECK (("stripe_checkout_attempts"."response_url" is null and "stripe_checkout_attempts"."completed_at" is null)
        or ("stripe_checkout_attempts"."response_url" is not null and "stripe_checkout_attempts"."completed_at" is not null
          and "stripe_checkout_attempts"."provider_started_at" is not null and "stripe_checkout_attempts"."lease_token" is null))
);
--> statement-breakpoint
ALTER TABLE "stripe_checkout_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_checkout_attempts_actor_key_unique" ON "stripe_checkout_attempts" USING btree ("organization_id","actor_id","key_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_checkout_attempts_active_organization_unique" ON "stripe_checkout_attempts" USING btree ("organization_id") WHERE "stripe_checkout_attempts"."resolved_at" is null;--> statement-breakpoint
CREATE POLICY "stripe_checkout_attempts_tenant_isolation" ON "stripe_checkout_attempts" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
--> statement-breakpoint
-- Drizzle enables RLS but does not force it for table owners.
ALTER TABLE "stripe_checkout_attempts" FORCE ROW LEVEL SECURITY;

ALTER TABLE "stripe_checkout_attempts" ADD COLUMN "provider_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "stripe_checkout_attempts" ADD COLUMN "provider_session_id" text;--> statement-breakpoint
ALTER TABLE "stripe_checkout_attempts" ADD COLUMN "provider_dispatch_key_digest" text;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_checkout_attempts_provider_session_unique" ON "stripe_checkout_attempts" USING btree ("provider_session_id") WHERE "stripe_checkout_attempts"."provider_session_id" is not null;--> statement-breakpoint
ALTER TABLE "stripe_checkout_attempts" ADD CONSTRAINT "stripe_checkout_attempts_provider_expiry_check" CHECK ("stripe_checkout_attempts"."provider_expires_at" is null
        or ("stripe_checkout_attempts"."provider_started_at" is not null and "stripe_checkout_attempts"."provider_expires_at" between 1 and 9007199254740991));--> statement-breakpoint
ALTER TABLE "stripe_checkout_attempts" ADD CONSTRAINT "stripe_checkout_attempts_dispatch_key_digest_check" CHECK ("stripe_checkout_attempts"."provider_dispatch_key_digest" is null
        or ("stripe_checkout_attempts"."provider_started_at" is not null and "stripe_checkout_attempts"."provider_dispatch_key_digest" ~ '^[a-f0-9]{64}$'));--> statement-breakpoint
ALTER TABLE "stripe_checkout_attempts" ADD CONSTRAINT "stripe_checkout_attempts_provider_session_check" CHECK ("stripe_checkout_attempts"."provider_session_id" is null
        or ("stripe_checkout_attempts"."provider_started_at" is not null and "stripe_checkout_attempts"."provider_session_id" ~ '^cs_[A-Za-z0-9_]{1,252}$'));
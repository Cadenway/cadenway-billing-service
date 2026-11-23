SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "outbox_events" DROP CONSTRAINT "outbox_events_status_check";--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_lease_check" CHECK (("outbox_events"."status" = 'leased' and "outbox_events"."lease_token" is not null and "outbox_events"."lease_expires_at" is not null)
        or ("outbox_events"."status" <> 'leased' and "outbox_events"."lease_token" is null and "outbox_events"."lease_expires_at" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_status_check" CHECK ("outbox_events"."status" in ('pending', 'leased', 'sent', 'failed')) NOT VALID;

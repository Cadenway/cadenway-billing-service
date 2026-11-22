# Usage

## Purpose

Measures billed seats, guests and storage bytes. Its domain checks prospective usage against a
supplied limit and detects when observed usage crosses the notification threshold. Organization owns
memberships and Storage owns attachments.

## Public entry points

None.

## Owned tables

- `usage_organizations` serializes projection writes per organization and records generation pointers
  and quota notification versions.
- `usage_generations` holds the measured totals, source cursors and durable catch-up checkpoint for
  each generation.
- `usage_observations` records the latest contribution or terminal version of each membership or
  attachment per generation. Its foreign key scopes the row to the same organization.
- `usage_threshold_intents` holds the latest pending threshold crossing per organization and
  metric, scoped to the generation that observed the crossing.

The additive migrations enable and force row-level security for each table. Observation
writes verify the current generation pointers under the organization lock before using them.

## API

`GET /internal/v1/billing/subscription` accepts a gateway token with a user actor and a verified
organization. The gateway proves that the user is an active owner. The endpoint reads the
current ready projection when usage ingestion is enabled and a bounded JetStream sample confirms
continuity against the selected generation's checkpoint. This sample also checks that the terminal
delivery latch is empty. It pairs measured usage with the effective plan and both limits from one
Payments entitlement snapshot. Otherwise it returns `503 billing.unavailable`.
All responses use `Cache-Control: private, no-store`.

## Events emitted

`evt.quota.threshold-reached.v1` records the metric, confirmed used amount, limit and quota
version for Notification. Its outbox row is committed when a covered generation confirms the
crossing after retained events have been acknowledged.

## Events consumed

The retained durables consume organization creation, member joins, role changes and removals,
and file uploads and deletions. Organization creation enrolls the tenant. The other five consumers
apply versioned observations to the current generations.

## Invariants

- An active owner, administrator or member contributes one billed seat. An active guest contributes
  one guest. Pending invitations and removed memberships contribute zero.
- A ready attachment contributes its verified size in bytes. Pending and deleted attachments
  contribute zero.
- Reads require a ready active generation in the signed organization. A candidate continues
  recording observations during a rebuild while measured usage is unavailable.
- Observed usage can exceed the limit. An increase may reach the limit. An increase above the limit
  is refused. Valid reductions and unchanged counts are allowed.
- The threshold fact is produced for a transition from below 80% to at least 80%. A subsequent
  crossing can occur after usage falls below 80% again.

## Transactions

`RecordUsageObservation` joins the event receipt transaction when called by a kit consumer. The
Drizzle unit of work locks the organization before changing observations and totals in the current
generations and recording an intent against the effective Payments limits. The worker checks
delivery continuity after acknowledgements, then uses the same tenant lock to confirm the exact
active generation and version and reads the current Payments limits. It commits the outbox event
and removes the intent together. A changed generation, a changed metric limit or a current total
below the threshold cancels publication. Candidate updates and failed writes do not create an alert.

The rebuild worker reads signed roster, membership and attachment pages outside transactions.
An organization lock serializes each page, invalidation and promotion. The persisted generation
and its version fence replay or concurrent updates. Each page uses at most one query to read its
existing observations and one upsert to write accepted observations before advancing the cursor.
Promotion requires both scans to finish and JetStream to confirm continuity for all six consumers.
An unavailable source or broker leaves the tenant eligible for a later retry.

## Decisions

- The notification threshold follows Organisation › Quotas et usage in the application mockup.
- Storage uses the verified size when an attachment becomes ready, so reservations do not increment
  measured storage usage.

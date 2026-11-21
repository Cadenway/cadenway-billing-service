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

The additive migration enables and forces row-level security for all three tables. Observation
writes verify the current generation pointers under the organization lock before using them.

## API

None. Billing routes require a published contract.

## Events emitted

None. `QuotaThresholdReached` is an internal domain fact. Publishing it for email and notifications
to organization owners and administrators requires a published Billing event contract.

## Events consumed

None. `RecordUsageObservation` applies membership and attachment versions. Its event adapters
depend on the published source and threshold contracts and their configured durable consumers.

## Invariants

- An active owner, administrator or member contributes one billed seat. An active guest contributes
  one guest. Pending invitations and removed memberships contribute zero.
- A ready attachment contributes its verified size in bytes. Pending and deleted attachments
  contribute zero.
- Observed usage can exceed the limit. An increase may reach the limit. An increase above the limit
  is refused. Valid reductions and unchanged counts are allowed.
- The threshold fact is produced for a transition from below 80% to at least 80%. A subsequent
  crossing can occur after usage falls below 80% again.

## Transactions

`RecordUsageObservation` joins the event receipt transaction when called by a kit consumer. The
Drizzle unit of work locks the organization before changing observations and totals in the current
generations. Its quota writer receives the same scope and the advanced metric version. Candidate
updates, unchanged observations and failed writes do not create a committed alert.

## Decisions

- The notification threshold follows Organisation › Quotas et usage in the application mockup.
- Storage uses the verified size when an attachment becomes ready, so reservations do not increment
  measured storage usage.

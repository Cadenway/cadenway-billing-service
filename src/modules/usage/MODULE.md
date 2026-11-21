# Usage

## Purpose

Measures billed seats, guests and storage bytes. Its domain checks prospective usage against a
supplied limit and detects when observed usage crosses the notification threshold. Organization owns
memberships and Storage owns attachments.

## Public entry points

None.

## Owned tables

None. Persisted usage projections require the source contracts and reconciliation path.

## API

None. Billing routes require a published contract.

## Events emitted

None. `QuotaThresholdReached` is an internal domain fact. Publishing it for email and notifications
to organization owners and administrators requires a published Billing event contract.

## Events consumed

None. The domain measures membership and attachment state supplied by its caller.

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

None. The rules operate on supplied values. A future projection update and its outbox write belong
in the same organization-scoped application transaction.

## Decisions

- The notification threshold follows Organisation › Quotas et usage in the application mockup.
- Storage uses the verified size when an attachment becomes ready, so reservations do not increment
  measured storage usage.

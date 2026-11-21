# Payments

## Purpose

Authenticates Stripe payment deliveries. Stripe owns hosted checkout and card data.

## Public entry points

None.

## Owned tables

- `stripe_bindings` records the current Stripe customer and subscription for an organization.
  Its version fences changes after a provider read outside the database transaction.
- `stripe_subscription_snapshots` stores the last committed plan, limits, cancellation state and
  entitlement version for the organization.
- `stripe_reconciliation_receipts` records settled provider events by organization and event ID.

Migration `0003_stripe_reconciliation.sql` creates these tables with forced tenant RLS.

## API

None. The app will register the incoming webhook after its contract is published.

## Events emitted

None.

## Events consumed

None.

## Invariants

- The original UTF-8 request bytes are bounded by the service JSON body limit.
- The signature header contains one recent timestamp and a valid Stripe `v1` signature for an
  active endpoint secret. Multiple signatures support rotation.
- The adapter authenticates the body before parsing JSON. It returns an object that downstream
  processing must validate before using the Stripe event ID and type.
- Verification failures report a category without including the body, header or signing secret.
- Reconciliation requires a verified current customer and subscription binding. An event cannot
  choose the organization or supply the entitlement limits.
- An entitlement change requires authorization from the quota fence. Deferred changes leave the
  snapshot and receipt available for reconciliation when the missing proof arrives.

## Transactions

Provider reads happen outside the tenant transaction. Settlement locks and rechecks the binding.
The entitlement snapshot and event receipt commit together with the writes required by the fence.
An unsuccessful settlement rolls back those changes together.

## Decisions

- The Stripe SDK verifies signatures locally. The webhook adapter receives the active endpoint
  secrets and uses the SDK's five-minute tolerance with the server clock.
- HTTP registration and the concrete quota and outbox fence await the published producer contracts.

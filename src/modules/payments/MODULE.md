# Payments

## Purpose

Authenticates Stripe payment deliveries. Stripe owns hosted checkout and card data.

## Public entry points

None.

## Owned tables

- `stripe_bindings` records the current Stripe customer and subscription for an organization.
  Its version fences changes after a provider read outside the database transaction. Each
  Stripe customer and subscription belongs to at most one organization.
- `stripe_subscription_snapshots` stores the last committed plan, limits, cancellation state and
  entitlement version for the organization.
- `stripe_reconciliation_receipts` records settled provider events by organization and event ID.

Migration `0003_stripe_reconciliation.sql` creates these tables with forced tenant RLS.
Migration `0004_stripe_binding_unique.sql` adds independent unique indexes for the provider
identities before Stripe admission is activated. The indexes build transactionally on the
previously dormant Stripe binding table. If the table has been populated ahead of activation,
check for duplicate provider identities and allow time for the build's write lock before rollout.
Migration `0005_stripe_receipt_event_unique.sql` adds an account-wide event ID guard to the
dormant receipts table. Existing tenant scoping stays in place. A collision at settlement
rolls back the entitlement and its receipt. The prior Billing release can run with these
additive indexes in place.

## API

- `POST /internal/v1/billing/webhooks/stripe` verifies the exact raw bytes after the signed
  global Gateway identity is established. Replies are private and noncacheable. Verified
  types outside subscription creation, update, deletion, pause and resume receive an empty 204. A supported event receives 204 after durable settlement or a confirmed duplicate.
  The account-wide receipt is checked before looking up the binding, so a replay can stop
  even if its original customer or subscription has since been replaced.
  Missing bindings, deferred settlement and settlement errors return `503 billing.unavailable`.
- The composed endpoint has no production settlement until Billing can coordinate quota
  changes with Organization and Storage and write the published outbox fact. Keep
  `BILLING_STRIPE_WEBHOOK_SECRETS` unset and the provider's webhook subscription disabled
  until this is available. The local mode defaults to `test`. Up to two signing keys can
  coexist during rotation.

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
- Each environment uses one Stripe account and mode. The global binding reader requires the
  exact customer and subscription pair through the system transaction runner. Missing or
  conflicting pairs and events carrying a connected account or separate authentication
  context have no match. Ordinary billing reads continue to use the tenant transaction runner.
- An entitlement change requires authorization from the quota fence. Deferred changes leave the
  snapshot and receipt available for reconciliation when the missing proof arrives.

## Transactions

Provider reads happen outside the tenant transaction. Settlement locks and rechecks the binding.
The entitlement snapshot and event receipt commit together with the writes required by the fence.
An unsuccessful settlement rolls back those changes together.

The webhook admission adapter verifies the Stripe signature and the configured mode before
global resolution. The lookup returns the provider pair and its revision with the organization
ID. Reconciliation compares the token before reading Stripe, then rechecks under the tenant
binding lock before applying an entitlement update. Supported events remain retryable until
this settlement commits. The endpoint does not store raw provider deliveries.

## Decisions

- The Stripe SDK verifies signatures locally. The webhook adapter receives the active endpoint
  secrets and uses the SDK's five-minute tolerance with the server clock.
- Initial Checkout ownership and Stripe webhook subscription configuration are coordinated with
  the quota and outbox fence before activation. Subscription deliveries never create bindings.

# Payments

## Purpose

Authenticates Stripe payment deliveries. Stripe owns hosted checkout and card data.

## Public entry points

| Entry point                                    | Consumers |
| ---------------------------------------------- | --------- |
| `payments.module`                              | `usage`   |
| `public/subscriptions/get-billing-entitlement` | `usage`   |

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
- `GET /internal/v1/billing/entitlement` reads the committed plan, limits and version for the
  tenant in a verified Organization or Storage system token whose actor ID matches its
  issuer. Replies are private and noncacheable. A successful read with no committed snapshot
  returns the Free limits at version zero. An unavailable or invalid snapshot returns 503.
  The read is available independently of Stripe, NATS and the Usage feature flag.

## Events emitted

- `subscription.changed.v1` carries the complete plan, limits and version after an authorized
  change, using the Billing system actor and the same tenant transaction as the snapshot
  and receipt. Delivery is at least once and can arrive out of order.

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
- The initial quota fence permits only transitions that preserve or increase each committed
  limit, using the Free baseline when no snapshot exists. A decrease needs a coordinated
  preparation protocol with Organization and Storage. A deferred event has no committed receipt
  and can be retried. A scheduled cancellation update alone preserves the entitlement version
  and produces no quota event.

## Transactions

Provider reads happen outside the tenant transaction. Settlement locks and rechecks the binding.
The entitlement snapshot and event receipt commit together with the writes required by the fence.
An unsuccessful settlement rolls back those changes together.
Settlement takes the organization entitlement lock before the binding row. Entitlement
readers take the shared lock so Usage can confirm threshold events under the same limits
until its transaction commits, including before the first snapshot exists.

The webhook admission adapter verifies the Stripe signature and the configured mode before
global resolution. The lookup returns the provider pair and its revision with the organization
ID. Reconciliation compares the token before reading Stripe, then rechecks under the tenant
binding lock before applying an entitlement update. Supported events remain retryable until
this settlement commits. The endpoint does not store raw provider deliveries.

## Decisions

- The Stripe SDK verifies signatures locally. The webhook adapter receives the active endpoint
  secrets and uses the SDK's five-minute tolerance with the server clock.
- Stripe settlement defaults to disabled. Activation needs trusted Checkout binding creation,
  production readiness of both quota owners and configured Stripe credentials and Team prices.
  The local mode defaults to `test`. Two endpoint signing keys can coexist during rotation.
  Subscription deliveries never create bindings.

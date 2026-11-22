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
- `stripe_checkout_attempts` reserves one unresolved hosted Checkout per organization, with
  a hashed key per actor. It stores a short lease, immutable Stripe request parameters and
  the response needed for replay.
- `stripe_checkout_receipts` deduplicates authenticated terminal Checkout deliveries. An expired
  session can have a receipt before any subscription binding exists.
- `stripe_webhook_inbox` admits verified event and provider identities with the locally resolved
  tenant. It holds lease and retry state, without storing request bodies or Stripe credentials.

Migration `0003_stripe_reconciliation.sql` creates the binding, snapshot and receipt tables
with forced tenant RLS.
Migration `0004_stripe_binding_unique.sql` adds independent unique indexes for the provider
identities before Stripe admission is activated. The indexes build transactionally on the
previously dormant Stripe binding table. If the table has been populated ahead of activation,
check for duplicate provider identities and allow time for the build's write lock before rollout.
Migration `0005_stripe_receipt_event_unique.sql` adds an account-wide event ID guard to the
dormant receipts table. Existing tenant scoping stays in place. A collision at settlement
rolls back the entitlement and its receipt. The prior Billing release can run with these
additive indexes in place.
Migration `0006_stripe_checkout_attempts.sql` adds the Checkout table with forced tenant RLS.
Migration `0007_stripe_checkout_settlement.sql` adds the receipt table with forced RLS and
unique provider keys. Global webhook lookup policies permit reads only for the exact provider
key or event ID selected in the system transaction.
Migration `0008_stripe_checkout_recovery.sql` adds the provider's session ID, immutable
expiration deadline and a digest of the dispatch credential. These fields are nullable
for attempts submitted by the earlier binary.
Migration `0009_stripe_webhook_inbox.sql` adds the inbox with forced RLS and a due-delivery
index. A worker-only system scope can claim pending rows. Other writes use the resolved tenant.
Migration `0010_stripe_checkout_customer.sql` adds the customer ID to the immutable Checkout
request. The value is nullable for earlier reservations and initial purchases.

## API

- `POST /internal/v1/billing/checkout` starts hosted Team Checkout for the verified Gateway
  user and organization. Gateway checks the owner's current role before forwarding every call.
  The service replays the original URL for the same actor and key for 24 hours.
- `POST /internal/v1/billing/webhooks/stripe` verifies the exact raw bytes after the signed
  global Gateway identity is established. Replies are private and noncacheable. Unsupported
  verified event types receive an empty 204. A supported event receives 204 after committed
  inbox admission, durable synchronous settlement or a confirmed duplicate.
  The account-wide receipt is checked before looking up the binding, so a replay can stop
  even if its original customer or subscription has since been replaced.
  Missing bindings and failed admissions return `503 billing.unavailable`. For events settled
  synchronously, deferred settlement and settlement errors also return 503.
- `GET /internal/v1/billing/entitlement` reads the committed plan, limits and version for the
  tenant in a verified Organization or Storage system token whose actor ID matches its
  issuer. Replies are private and noncacheable. A successful read with no committed snapshot
  returns the Free limits at version zero. An unavailable or invalid snapshot returns 503.
  The read is available independently of Stripe, NATS and the Usage feature flag.
- `GET /internal/v1/billing/invoices` reads the customer binding for the organization from a
  verified Gateway user token. It returns an empty first page for an organization without a
  binding. Linked reads use a bounded Stripe page and an encrypted cursor bound to the
  organization, customer and configured mode. Replies are private and noncacheable.

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
- The quota fence permits monotonic changes and the explicitly enabled return from Team to the
  canonical Free allowance of five seats and 2,000,000,000 bytes. Billing requires the bound
  subscription to be canceled on a current Stripe read. A scheduled cancellation alone records
  its marker and keeps the current Team entitlement version. A deferred event has no committed
  receipt and can be retried.
- A committed Free snapshot is terminal for the old binding. Only a new paid Checkout can
  replace the bound subscription and restore Team.

## Transactions

Provider reads happen outside the tenant transaction. Settlement locks and rechecks the binding.
The entitlement snapshot and event receipt commit together with the writes required by the fence.
An unsuccessful settlement rolls back those changes together.
Settlement takes the organization entitlement lock before the binding row. Entitlement
readers take the shared lock so Usage can confirm threshold events under the same limits
until its transaction commits, including before the first snapshot exists.

The webhook admission adapter verifies the Stripe signature and the configured mode before
global resolution. With inbox admission enabled, an exact active Stripe subscription binding
or a Checkout reservation with matching signed references establishes the tenant. A durable
insert commits before 204. Checkout deliveries without matching references still use the
canonical synchronous path. A worker claims one due event at a time, with a 60-second lease,
and releases the database transaction before Stripe reads. At each attempt, it re-resolves
the binding or reservation and reconciles only within the admitted tenant. The existing
settlement receipt makes a replay safe after a crash between settlement and inbox completion.
When a Checkout replaces a subscription, pending work for the old subscription finishes
without modifying the entitlement once the tenant's current binding proves the same customer.
A tenant-scoped lease check guards status changes. Pending work survives failures and retries
at bounded intervals up to 15 minutes without discarding work. Warnings report failed stages,
attempt counts, age and a digest for correlation. The endpoint never stores raw provider deliveries.

## Decisions

- The Stripe SDK verifies signatures locally. The webhook adapter receives the active endpoint
  secrets and uses the SDK's five-minute tolerance with the server clock.
- Stripe settlement defaults to disabled. Activation needs trusted Checkout binding creation,
  production readiness of both quota owners and configured Stripe credentials and Team prices.
  The local mode defaults to `test`. Two endpoint signing keys can coexist during rotation.
  Subscription deliveries never create bindings.
- `BILLING_STRIPE_FREE_RETURN_ENABLED` defaults to false and requires Stripe settlement. Enable
  it after all Organization and Storage consumers can apply the lower versioned limits under
  their respective admission locks. Existing members and verified attachments are retained.
  New admissions use the Free limits once each service has applied the event.
- `BILLING_STRIPE_WEBHOOK_INBOX_ENABLED` defaults to false. Apply the additive migration and use
  a worker-capable binary before enabling admission. To return to synchronous admission,
  disable the inbox flag and keep settlement enabled so the worker drains acknowledged work.
  Empty the pending inbox before returning to a binary without the worker or switching Stripe
  account or mode. Rows with a null `finished_at` are still pending.
- Linked invoice reads require an invoice cursor key and a Stripe API key for the same mode.
  Billing rechecks the customer binding after reading Stripe. The cursor key is configured
  independently of webhook verification and rekeying invalidates existing invoice cursors.
- Checkout leases fence concurrent attempts and recoveries after an uncertain provider call.
  A Checkout with a saved provider request stays exclusive until Billing can prove its
  outcome. A Stripe validation error identifying a missing line-item price can resolve only
  the first dispatch, with its exact unexpired lease and unchanged reservation version.
  Billing keeps the resolved idempotency record and accepts a fresh key once the price is fixed.
  A failed retry or any other provider error keeps the reservation exclusive until reconciliation.
  Provider I/O stays outside reservation and resolution transactions.
- Checkout creation requires one complete Organization membership page and charges the current
  number of active billable seats. Team admission capacity is at least the Free seat limit.
  Creation refuses a lower effective quota than the committed quota. A paid session matching
  its reservation records the initial binding, entitlement, receipt and outbox fact in one
  tenant transaction.
- With returns to Free enabled, an organization with a committed Free snapshot can start a new
  Checkout on its bound Stripe customer, preserving invoice history. Settlement updates the
  subscription and binding revision together with the entitlement and retains previous receipts.
  Before sending any new request, Billing commits its exact Stripe parameters, including an
  absolute two-hour expiration and the bound customer when applicable. Every POST uses those
  same parameters and idempotency key. The database and adapter
  stop sending POSTs before the expiration gets too close to Stripe's minimum lifetime. A
  changed Stripe credential allows only read-only recovery for existing reservations.
- A retry can read the saved Stripe session ID or locate a unique matching provider reference
  through a bounded list followed by a canonical read. A verified open URL can be returned
  only to the original actor and idempotency key. A paid session goes through the same
  settlement transaction as a webhook. A verified expired session with no payment or
  subscription can release the reservation. A missing, pending or ambiguous response keeps it
  reserved. Historical requests without a stored expiration use read-only recovery.
- Older Checkout dispatchers predate the immutable deadline. Stop them before enabling the
  new path. The additive schema remains readable by the previous binary. Keep Checkout
  creation disabled if reverting to that binary while newer reservations remain open.
- Before reverting to a binary that predates the persisted Checkout customer, disable new
  returns and new Checkout creation, then resolve every outstanding Checkout that reuses a
  customer with the current settlement worker. The earlier binary cannot settle these
  reservations. Keep consumers that support the Free snapshot in place for in-flight
  entitlement events.

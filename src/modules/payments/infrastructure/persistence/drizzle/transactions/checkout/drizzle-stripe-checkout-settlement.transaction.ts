import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { z } from 'zod';

import type { StripeCheckoutSettlement } from '../../../../../application/ports/outbound/transactions/checkout/stripe-checkout-settlement.port.js';
import { effectiveTeamSeatLimit } from '../../../../../domain/policies/subscriptions/stripe-subscription.policy.js';
import type { StripeSubscriptionDecision } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-decision.value-object.js';
import { lockBillingEntitlement } from '../subscriptions/lock-billing-entitlement.transaction.js';
import type { StripeEntitlementFence } from '../subscriptions/stripe-entitlement-fence.transaction.js';

const reservation = z.object({
  id: z.uuid(),
  provider_started_at: z.date().nullable(),
  provider_session_id: z.string().nullable(),
  provider_customer_id: z
    .string()
    .max(255)
    .regex(/^cus_[A-Za-z0-9_]+$/u)
    .nullable(),
  price_id: z.string().nullable(),
  quantity: z.coerce.number().int().nullable(),
  resolved_at: z.date().nullable(),
});

const snapshot = z.object({
  plan: z.enum(['free', 'team']),
  seats: z.coerce.number().int().nonnegative(),
  storage_bytes: z.coerce.number().int().nonnegative(),
  scheduled_cancellation: z.boolean(),
  version: z.coerce.number().int().positive(),
});
const priorReceipt = z.object({ terminal_status: z.enum(['complete', 'expired']) });
const stripeBinding = z.object({ customer_id: z.string(), subscription_id: z.string() });

/** Commits a verified terminal Checkout and its entitlement in one tenant transaction. */
export class DrizzleStripeCheckoutSettlement implements StripeCheckoutSettlement {
  // #region Constructor
  /** Supplies tenant isolation, the shared quota fence, Stripe mode and the Free allowances. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly fence: StripeEntitlementFence,
    private readonly liveMode: boolean,
    private readonly freeSeatLimit: number,
    private readonly freeStorageByteLimit?: number,
  ) {}
  // #endregion

  // #region Methods
  /** Applies a terminal Checkout after locking and matching the durable reservation. */
  public async settle(
    input: Parameters<StripeCheckoutSettlement['settle']>[0],
  ): ReturnType<StripeCheckoutSettlement['settle']> {
    const { organizationId, eventId, session, decision } = input;
    if (
      session.liveMode !== this.liveMode ||
      !/^[!-~]{1,255}$/u.test(eventId) ||
      !/^cs_[A-Za-z0-9_]{1,252}$/u.test(session.sessionId) ||
      !/^[!-~]{1,255}$/u.test(session.providerKey)
    )
      return 'retry';

    return this.runner.run(async (scope) => {
      if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
        throw new Error('Checkout settlement organization does not match the tenant scope.');
      }
      await lockBillingEntitlement(scope, organizationId, 'exclusive');
      await scope.client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `billing.checkout:${organizationId.toLowerCase()}`,
      ]);

      const settled = await scope.client.query(
        'select 1 from stripe_checkout_receipts where organization_id = $1 and event_id = $2 limit 1',
        [organizationId, eventId],
      );
      if (settled.rows.length !== 0) return 'duplicate';

      const attempts = await scope.client.query(
        `select id, provider_started_at, provider_session_id, provider_customer_id,
                price_id, quantity, resolved_at
         from stripe_checkout_attempts
         where organization_id = $1 and provider_key = $2
         limit 1 for update`,
        [organizationId, session.providerKey],
      );
      if (attempts.rows.length !== 1) return 'retry';
      const attempt = reservation.parse(attempts.rows[0]);
      if (
        attempt.provider_started_at === null ||
        (attempt.provider_session_id !== null &&
          attempt.provider_session_id !== session.sessionId) ||
        (attempt.provider_customer_id !== null &&
          attempt.provider_customer_id !== session.customerId)
      )
        return 'retry';

      if (attempt.resolved_at !== null) {
        const prior = await scope.client.query(
          `select terminal_status from stripe_checkout_receipts
           where organization_id = $1 and provider_key = $2 and session_id = $3
           limit 1`,
          [organizationId, session.providerKey, session.sessionId],
        );
        const receipt = priorReceipt.safeParse(prior.rows[0]);
        if (!receipt.success || receipt.data.terminal_status !== session.status) return 'retry';
        await scope.client.query(
          `insert into stripe_checkout_receipts
             (organization_id, event_id, provider_key, session_id, terminal_status)
           values ($1, $2, $3, $4, $5)`,
          [organizationId, eventId, session.providerKey, session.sessionId, session.status],
        );
        return 'duplicate';
      }

      let outcome: 'applied' | 'unchanged' | 'expired';
      if (session.status === 'expired') {
        if (decision !== null) return 'retry';
        outcome = 'expired';
      } else {
        if (
          decision?.plan !== 'team' ||
          session.priceId !== attempt.price_id ||
          session.quantity !== attempt.quantity ||
          decision.limits.seats !== effectiveTeamSeatLimit(session.quantity, this.freeSeatLimit) ||
          !session.customerId ||
          !session.subscriptionId
        )
          return 'retry';

        const bindings = await scope.client.query(
          'select customer_id, subscription_id from stripe_bindings where organization_id = $1 limit 1 for update',
          [organizationId],
        );
        const binding =
          bindings.rows[0] === undefined ? undefined : stripeBinding.parse(bindings.rows[0]);
        const snapshots = await scope.client.query(
          `select plan, seats, storage_bytes, scheduled_cancellation, version
           from stripe_subscription_snapshots where organization_id = $1 limit 1 for update`,
          [organizationId],
        );
        const current = snapshots.rows[0] === undefined ? null : snapshot.parse(snapshots.rows[0]);
        if (attempt.provider_customer_id !== null) {
          if (
            binding?.customer_id !== attempt.provider_customer_id ||
            binding.subscription_id === session.subscriptionId ||
            current?.plan !== 'free' ||
            current.seats !== this.freeSeatLimit ||
            current.storage_bytes !== this.freeStorageByteLimit
          )
            return 'retry';
        } else if (
          binding !== undefined &&
          (binding.customer_id !== session.customerId ||
            binding.subscription_id !== session.subscriptionId)
        ) {
          return 'retry';
        }
        const previous: Extract<StripeSubscriptionDecision, { readonly kind: 'apply' }> | null =
          current === null
            ? null
            : current.plan === 'free'
              ? {
                  kind: 'apply',
                  plan: 'free',
                  limits: { seats: current.seats, storageBytes: current.storage_bytes },
                }
              : {
                  kind: 'apply',
                  plan: 'team',
                  limits: { seats: current.seats, storageBytes: current.storage_bytes },
                  scheduledCancellation: current.scheduled_cancellation,
                };
        const changed =
          current?.plan !== decision.plan ||
          current.seats !== decision.limits.seats ||
          current.storage_bytes !== decision.limits.storageBytes;
        const nextVersion = (current?.version ?? 0) + 1;
        if (!Number.isSafeInteger(nextVersion))
          throw new Error('Stripe entitlement version exhausted.');
        if (
          changed &&
          !(await this.fence.authorizeChange(
            scope,
            organizationId,
            previous,
            decision,
            nextVersion,
          ))
        ) {
          return 'retry';
        }

        if (binding === undefined) {
          await scope.client.query(
            'insert into stripe_bindings (organization_id, customer_id, subscription_id) values ($1, $2, $3)',
            [organizationId, session.customerId, session.subscriptionId],
          );
        } else if (attempt.provider_customer_id !== null) {
          await scope.client.query(
            `update stripe_bindings
             set subscription_id = $2, version = version + 1, updated_at = now()
             where organization_id = $1`,
            [organizationId, session.subscriptionId],
          );
        }
        if (changed) {
          await scope.client.query(
            `insert into stripe_subscription_snapshots
               (organization_id, plan, seats, storage_bytes, scheduled_cancellation, version)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (organization_id) do update
               set plan = excluded.plan, seats = excluded.seats, storage_bytes = excluded.storage_bytes,
                   scheduled_cancellation = excluded.scheduled_cancellation, version = excluded.version,
                   updated_at = now()`,
            [
              organizationId,
              decision.plan,
              decision.limits.seats,
              decision.limits.storageBytes,
              decision.scheduledCancellation,
              nextVersion,
            ],
          );
        } else if (current.scheduled_cancellation !== decision.scheduledCancellation) {
          await scope.client.query(
            'update stripe_subscription_snapshots set scheduled_cancellation = $2, updated_at = now() where organization_id = $1',
            [organizationId, decision.scheduledCancellation],
          );
        }
        outcome = changed ? 'applied' : 'unchanged';
      }

      await scope.client.query(
        `update stripe_checkout_attempts
         set resolved_at = now(), lease_token = null, lease_expires_at = null,
             provider_session_id = $3, updated_at = now(), version = version + 1
         where organization_id = $1 and id = $2`,
        [organizationId, attempt.id, session.sessionId],
      );
      await scope.client.query(
        `insert into stripe_checkout_receipts
           (organization_id, event_id, provider_key, session_id, terminal_status)
         values ($1, $2, $3, $4, $5)`,
        [organizationId, eventId, session.providerKey, session.sessionId, session.status],
      );
      return outcome;
    });
  }
  // #endregion
}

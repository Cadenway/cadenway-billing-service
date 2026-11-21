import {
  assertNoActiveTransaction,
  type DatabaseSchema,
  type TenantTransactionRunner,
  type TransactionScope,
} from '@cadenway/nest-common/database';

import type { StripeWebhookDelivery } from '../../../../../application/models/webhooks/stripe-webhook-delivery.model.js';
import type { StripeWebhookLease } from '../../../../../application/models/webhooks/stripe-webhook-lease.model.js';
import type { StripeWebhookInbox } from '../../../../../application/ports/outbound/persistence/webhooks/stripe-webhook-inbox.port.js';

/** Persists admitted Stripe identities and fences the completion of their leases. */
export class DrizzleStripeWebhookInboxWrites implements Pick<
  StripeWebhookInbox,
  'enqueue' | 'finish'
> {
  // #region Constructor
  /** Binds every write to the service's tenant transaction runner. */
  public constructor(private readonly tenant: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** An existing event is accepted only when every stored identity matches the same tenant. */
  public async enqueue(delivery: StripeWebhookDelivery): Promise<boolean> {
    assertNoActiveTransaction();
    return this.tenant.run(async (scope) => {
      this.assertTenant(scope, delivery.organizationId);
      const sessionId = delivery.kind === 'checkout' ? delivery.sessionId : null;
      const customerId = delivery.kind === 'subscription' ? delivery.customerId : null;
      const subscriptionId = delivery.kind === 'subscription' ? delivery.subscriptionId : null;
      const inserted = await scope.client.query(
        `insert into stripe_webhook_inbox
           (organization_id, event_id, kind, session_id, customer_id, subscription_id)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (event_id) do nothing
         returning event_id`,
        [
          delivery.organizationId,
          delivery.eventId,
          delivery.kind,
          sessionId,
          customerId,
          subscriptionId,
        ],
      );
      if (inserted.rows.length === 1) return true;

      const matching = await scope.client.query(
        `select event_id from stripe_webhook_inbox
         where organization_id = $1 and event_id = $2 and kind = $3
           and session_id is not distinct from $4
           and customer_id is not distinct from $5
           and subscription_id is not distinct from $6
         limit 1`,
        [
          delivery.organizationId,
          delivery.eventId,
          delivery.kind,
          sessionId,
          customerId,
          subscriptionId,
        ],
      );
      return matching.rows.length === 1;
    });
  }

  /** Keeps a lost or superseded lease from deciding the result of a newer attempt. */
  public async finish(lease: StripeWebhookLease, outcome: 'settled' | 'retry'): Promise<boolean> {
    assertNoActiveTransaction();
    const { organizationId, eventId } = lease.delivery;
    return this.tenant.run(async (scope) => {
      this.assertTenant(scope, organizationId);
      const result = await scope.client.query(
        `update stripe_webhook_inbox
         set lease_token = null,
             finished_at = case when $4 = 'settled' then clock_timestamp() else null end,
             available_at = case when $4 = 'retry'
               then clock_timestamp() + make_interval(secs => least(900, power(2, least(claim_count, 10)))::double precision)
               else available_at end,
             updated_at = clock_timestamp()
         where organization_id = $1 and event_id = $2 and lease_token = $3
           and finished_at is null and available_at > clock_timestamp()
         returning event_id`,
        [organizationId, eventId, lease.token, outcome],
      );
      return result.rows.length === 1;
    });
  }

  private assertTenant(scope: TransactionScope<DatabaseSchema>, organizationId: string): void {
    if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
      throw new Error('Stripe webhook inbox requires the matching tenant scope.');
    }
  }
  // #endregion
}

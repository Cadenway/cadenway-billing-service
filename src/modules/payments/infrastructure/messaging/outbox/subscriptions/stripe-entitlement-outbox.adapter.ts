import {
  eventSchemas as billingEvents,
  SUBSCRIPTION_CHANGED_V1,
} from '@cadenway/contracts/events/billing-service';
import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import type { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';

import type { BillingEntitlement } from '../../../../application/models/subscriptions/billing-entitlement.model.js';

/** Appends the exact committed quota facts using Billing's system actor. */
export class StripeEntitlementOutbox {
  // #region Constructor
  /** Uses the writer that supplies the stable event identity and trace context. */
  public constructor(private readonly writer: Pick<OutboxWriter, 'append'>) {}
  // #endregion

  // #region Methods
  /** Persists the fact in the same tenant transaction as the snapshot and receipt. */
  public async append(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    entitlement: BillingEntitlement,
  ): Promise<void> {
    if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
      throw new Error('Subscription entitlement events require the organization transaction.');
    }
    await this.writer.append(scope, billingEvents, SUBSCRIPTION_CHANGED_V1, {
      organizationId,
      actor: { type: 'system', id: 'billing-service' },
      ...entitlement,
    });
  }
  // #endregion
}

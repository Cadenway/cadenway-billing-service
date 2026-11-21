import {
  eventSchemas as billingEvents,
  QUOTA_THRESHOLD_REACHED_V1,
} from '@cadenway/contracts/events/billing-service';
import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import type { OutboxWriter } from '@cadenway/nest-messaging/outbox/writer';

import type { QuotaThresholdReached } from '../../../../domain/events/quotas/quota-threshold-reached.event.js';

/** Records quota crossings through the messaging kit in the writer's transaction. */
export class QuotaThresholdOutbox {
  // #region Constructor
  /** Uses the writer that assigns the event identity, timestamp and trace context. */
  public constructor(private readonly writer: Pick<OutboxWriter, 'append'>) {}
  // #endregion

  // #region Methods
  /** Persists the published Billing envelope in the transaction that advanced the quota version. */
  public async append(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    version: number,
    fact: QuotaThresholdReached,
  ): Promise<void> {
    if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
      throw new Error('Quota threshold events require the organization transaction.');
    }

    await this.writer.append(scope, billingEvents, QUOTA_THRESHOLD_REACHED_V1, {
      organizationId,
      actor: { type: 'system', id: 'billing-service' },
      version,
      metric: fact.metric,
      thresholdPercent: fact.thresholdPercent,
      used: fact.used,
      limit: fact.limit,
    });
  }
  // #endregion
}

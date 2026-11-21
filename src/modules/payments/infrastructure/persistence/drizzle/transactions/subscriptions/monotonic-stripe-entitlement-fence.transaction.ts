import type { BillingEntitlement } from '../../../../../application/models/subscriptions/billing-entitlement.model.js';
import type { StripeEntitlementOutbox } from '../../../../messaging/outbox/subscriptions/stripe-entitlement-outbox.adapter.js';
import type { StripeEntitlementFence } from './stripe-entitlement-fence.transaction.js';

/** Authorizes only changes that cannot lower a seat or storage admission limit. */
export class MonotonicStripeEntitlementFence implements StripeEntitlementFence {
  // #region Constructor
  /** Supplies the effective Free baseline and the transaction-bound event writer. */
  public constructor(
    private readonly baseline: Pick<BillingEntitlement, 'seatLimit' | 'storageByteLimit'>,
    private readonly outbox: Pick<StripeEntitlementOutbox, 'append'>,
  ) {}
  // #endregion

  // #region Properties
  /** Quota owners have no coordinated proof authorizing a decrease in this rollout. */
  public readonly confirmedUsage: StripeEntitlementFence['confirmedUsage'] = () =>
    Promise.resolve(null);

  /** Appends complete limits only when neither admission limit decreases. */
  public readonly authorizeChange: StripeEntitlementFence['authorizeChange'] = async (
    scope,
    organizationId,
    previous,
    next,
    nextVersion,
  ) => {
    const { seats, storageBytes } = next.limits;
    const currentSeats = previous?.limits.seats ?? this.baseline.seatLimit;
    const currentStorage = previous?.limits.storageBytes ?? this.baseline.storageByteLimit;
    if (seats < currentSeats || storageBytes < currentStorage) return false;

    await this.outbox.append(scope, organizationId, {
      plan: next.plan,
      seatLimit: seats,
      storageByteLimit: storageBytes,
      version: nextVersion,
    });
    return true;
  };
  // #endregion
}

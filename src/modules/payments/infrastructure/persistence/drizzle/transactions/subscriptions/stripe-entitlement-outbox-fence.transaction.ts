import type { BillingEntitlement } from '../../../../../application/models/subscriptions/billing-entitlement.model.js';
import type { StripeEntitlementOutbox } from '../../../../messaging/outbox/subscriptions/stripe-entitlement-outbox.adapter.js';
import type { StripeEntitlementFence } from './stripe-entitlement-fence.transaction.js';

/** Appends versioned limits for monotonic changes and explicitly enabled cancellation returns. */
export class StripeEntitlementOutboxFence implements StripeEntitlementFence {
  // #region Constructor
  /** Supplies the effective Free baseline and the transaction-bound event writer. */
  public constructor(
    private readonly baseline: Pick<BillingEntitlement, 'seatLimit' | 'storageByteLimit'>,
    private readonly outbox: Pick<StripeEntitlementOutbox, 'append'>,
    private readonly freeReturnEnabled: boolean = false,
  ) {}
  // #endregion

  // #region Properties
  /** Checkout uses the default monotonic fence. Only cancellation settlement enables a lower cap. */
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
    if (next.plan === 'free') {
      if (
        !this.freeReturnEnabled ||
        previous?.plan !== 'team' ||
        seats !== this.baseline.seatLimit ||
        storageBytes !== this.baseline.storageByteLimit
      ) {
        return false;
      }
    } else if (seats < currentSeats || storageBytes < currentStorage) {
      return false;
    }

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

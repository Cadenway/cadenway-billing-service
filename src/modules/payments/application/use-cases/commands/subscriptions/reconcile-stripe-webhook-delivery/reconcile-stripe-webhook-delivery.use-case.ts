import type { StripeWebhookDelivery } from '../../../../models/webhooks/stripe-webhook-delivery.model.js';
import type { StripeBindingReader } from '../../../../ports/outbound/persistence/subscriptions/stripe-binding-reader.port.js';
import type { StripeWebhookBindingReader } from '../../../../ports/outbound/persistence/subscriptions/stripe-webhook-binding-reader.port.js';
import type { ReconcileStripeSubscription } from '../reconcile-stripe-subscription/reconcile-stripe-subscription.use-case.js';
import type { ReconcileStripeCheckout } from '../../checkout/reconcile-stripe-checkout/reconcile-stripe-checkout.use-case.js';

/** Reuses canonical settlement for a durable inbox delivery. */
export class ReconcileStripeWebhookDelivery {
  // #region Constructor
  /** Binds the global lookup, tenant binding proof and settlement operations. */
  public constructor(
    private readonly bindings: StripeWebhookBindingReader,
    private readonly readTenantBinding: StripeBindingReader['read'],
    private readonly settleSubscription: ReconcileStripeSubscription['execute'],
    private readonly settleCheckout: ReconcileStripeCheckout['execute'],
  ) {}
  // #endregion

  // #region Methods
  /** Rechecks ownership on this attempt and preserves the admitted tenant. */
  public async execute(delivery: StripeWebhookDelivery): Promise<'settled' | 'retry'> {
    if (delivery.kind === 'checkout') {
      const settlement = await this.settleCheckout({
        eventId: delivery.eventId,
        sessionId: delivery.sessionId,
        expectedOrganizationId: delivery.organizationId,
      });
      return settlement.status === 'retry' ? 'retry' : 'settled';
    }

    if (await this.bindings.hasSettlement(delivery.eventId)) return 'settled';
    const current = await this.bindings.resolve({
      account: null,
      authContext: null,
      customerId: delivery.customerId,
      subscriptionId: delivery.subscriptionId,
    });
    if (current === null) {
      // The inbox admitted the old exact pair. A new subscription for the same customer's
      // tenant supersedes that pair and ends this pending work without touching entitlements.
      const replacement = await this.readTenantBinding(delivery.organizationId);
      return replacement?.binding.customerId === delivery.customerId &&
        replacement.binding.subscriptionId !== delivery.subscriptionId
        ? 'settled'
        : 'retry';
    }
    if (current.organizationId !== delivery.organizationId) return 'retry';
    const settlement = await this.settleSubscription({
      organizationId: current.organizationId,
      eventId: delivery.eventId,
      acceptedBinding: current,
    });
    return settlement.status === 'retry' ? 'retry' : 'settled';
  }
  // #endregion
}

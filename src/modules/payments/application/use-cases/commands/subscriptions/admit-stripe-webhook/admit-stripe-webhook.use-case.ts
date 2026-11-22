import type { StripeWebhookAuthenticator } from '../../../../models/subscriptions/stripe-webhook-authenticator.model.js';
import type { StripeCheckoutAttemptReader } from '../../../../ports/outbound/persistence/checkout/stripe-checkout-attempt-reader.port.js';
import type { StripeWebhookBindingReader } from '../../../../ports/outbound/persistence/subscriptions/stripe-webhook-binding-reader.port.js';
import type { StripeWebhookInbox } from '../../../../ports/outbound/persistence/webhooks/stripe-webhook-inbox.port.js';
import type { ReconcileStripeSubscription } from '../reconcile-stripe-subscription/reconcile-stripe-subscription.use-case.js';
import type { ReconcileStripeCheckout } from '../../checkout/reconcile-stripe-checkout/reconcile-stripe-checkout.use-case.js';
import type { AdmitStripeWebhookInput } from './admit-stripe-webhook.input.js';
import type { AdmitStripeWebhookOutput } from './admit-stripe-webhook.output.js';

/** Admits signed deliveries through Billing's current Stripe records. */
export class AdmitStripeWebhook {
  // #region Constructor
  /** Binds authorization, settlement and optional durable admission. */
  public constructor(
    private readonly authenticate: StripeWebhookAuthenticator,
    private readonly bindings: StripeWebhookBindingReader,
    private readonly settle: ReconcileStripeSubscription['execute'] | null,
    private readonly settleCheckout: ReconcileStripeCheckout['execute'] | null = null,
    private readonly durable: {
      readonly checkoutAttempts: StripeCheckoutAttemptReader;
      readonly enqueue: StripeWebhookInbox['enqueue'];
    } | null = null,
  ) {}
  // #endregion

  // #region Methods
  /** Resolves the verified pair and retains the exact binding through settlement. */
  public async execute(input: AdmitStripeWebhookInput): Promise<AdmitStripeWebhookOutput> {
    const delivery = this.authenticate(input.rawBody, input.signature);
    if (delivery.kind === 'checkout') {
      if (this.settleCheckout === null) return 'unavailable';
      if (this.durable !== null && delivery.providerKey !== undefined) {
        if (await this.durable.checkoutAttempts.hasSettlement(delivery.eventId)) return 'accepted';
        const attempt = await this.durable.checkoutAttempts.resolve(delivery.providerKey);
        if (attempt === null) return 'unavailable';
        const recorded = await this.durable.enqueue({
          kind: 'checkout',
          organizationId: attempt.organizationId,
          eventId: delivery.eventId,
          sessionId: delivery.sessionId,
        });
        return recorded ? 'accepted' : 'unavailable';
      }
      const result = await this.settleCheckout({
        eventId: delivery.eventId,
        sessionId: delivery.sessionId,
      });
      return result.status === 'retry' ? 'unavailable' : 'accepted';
    }
    if (delivery.kind !== 'subscription') return delivery.kind;
    if (await this.bindings.hasSettlement(delivery.eventId)) return 'accepted';
    if (this.settle === null) return 'unavailable';

    const { customerId, subscriptionId } = delivery;
    const binding = await this.bindings.resolve({
      account: null,
      authContext: null,
      customerId,
      subscriptionId,
    });
    if (binding === null) return 'unavailable';
    if (this.durable !== null) {
      const recorded = await this.durable.enqueue({
        ...delivery,
        organizationId: binding.organizationId,
      });
      return recorded ? 'accepted' : 'unavailable';
    }

    const result = await this.settle({
      organizationId: binding.organizationId,
      eventId: delivery.eventId,
      acceptedBinding: binding,
    });
    return result.status === 'retry' ? 'unavailable' : 'accepted';
  }
  // #endregion
}

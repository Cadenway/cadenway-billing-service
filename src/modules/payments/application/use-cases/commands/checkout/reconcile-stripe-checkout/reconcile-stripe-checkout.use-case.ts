import { resolveStripeSubscription } from '../../../../../domain/policies/subscriptions/stripe-subscription.policy.js';
import type { StripeSubscriptionReconciliation } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-reconciliation.value-object.js';
import type { StripeCheckoutAttemptReader } from '../../../../ports/outbound/persistence/checkout/stripe-checkout-attempt-reader.port.js';
import type { StripeCheckoutSessionReader } from '../../../../ports/outbound/providers/checkout/stripe-checkout-session-reader.port.js';
import type { StripeSubscriptionProvider } from '../../../../ports/outbound/providers/subscriptions/stripe-subscription-provider.port.js';
import type { StripeCheckoutSettlement } from '../../../../ports/outbound/transactions/checkout/stripe-checkout-settlement.port.js';
import type { ReconcileStripeCheckoutInput } from './reconcile-stripe-checkout.input.js';
import type { ReconcileStripeCheckoutOutput } from './reconcile-stripe-checkout.output.js';

/** Reconciles an authenticated Checkout delivery against Billing's reservation and Stripe. */
export class ReconcileStripeCheckout {
  // #region Constructor
  /** Binds current provider reads and one atomic tenant settlement. */
  public constructor(
    private readonly attempts: StripeCheckoutAttemptReader,
    private readonly sessions: StripeCheckoutSessionReader,
    private readonly subscriptions: StripeSubscriptionProvider,
    private readonly settlement: StripeCheckoutSettlement,
    private readonly settings: StripeSubscriptionReconciliation['settings'],
  ) {}
  // #endregion

  // #region Methods
  /** Re-reads current provider state and commits only an authorized terminal outcome. */
  public async execute(
    input: ReconcileStripeCheckoutInput,
  ): Promise<ReconcileStripeCheckoutOutput> {
    if (await this.attempts.hasSettlement(input.eventId)) return { status: 'duplicate' };

    const session = await this.sessions.retrieve(input.sessionId);
    if (
      session.status === 'pending' ||
      session.sessionId !== input.sessionId ||
      session.liveMode !== this.settings.liveMode ||
      session.providerKey.length === 0
    )
      return { status: 'retry' };

    const attempt = await this.attempts.resolve(session.providerKey);
    if (attempt === null) {
      return { status: (await this.attempts.hasSettlement(input.eventId)) ? 'duplicate' : 'retry' };
    }

    if (session.status === 'expired') {
      return {
        status: await this.settlement.settle({
          organizationId: attempt.organizationId,
          eventId: input.eventId,
          session,
          decision: null,
        }),
      };
    }

    const subscription = await this.subscriptions.retrieve(session.subscriptionId);
    const decision = resolveStripeSubscription({
      binding: { customerId: session.customerId, subscriptionId: session.subscriptionId },
      settings: this.settings,
      subscription,
      confirmedUsage: null,
    });
    if (
      decision.kind !== 'apply' ||
      decision.plan !== 'team' ||
      subscription.items.length !== 1 ||
      subscription.items[0]?.priceId !== session.priceId ||
      decision.limits.seats !== session.quantity
    )
      return { status: 'retry' };

    return {
      status: await this.settlement.settle({
        organizationId: attempt.organizationId,
        eventId: input.eventId,
        session,
        decision,
      }),
    };
  }
  // #endregion
}

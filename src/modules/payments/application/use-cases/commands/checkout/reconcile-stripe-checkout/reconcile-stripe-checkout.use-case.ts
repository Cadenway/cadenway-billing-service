import { resolveStripeSubscription } from '../../../../../domain/policies/subscriptions/stripe-subscription.policy.js';
import type { StripeSubscriptionReconciliation } from '../../../../../domain/value-objects/subscriptions/stripe-subscription-reconciliation.value-object.js';
import type { StripeCheckoutSession } from '../../../../models/checkout/stripe-checkout-session.model.js';
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

    const session = await this.readTerminal(input.sessionId);
    if (session === null) return { status: 'retry' };
    const attempt = await this.attempts.resolve(session.providerKey);
    if (attempt === null) {
      return { status: (await this.attempts.hasSettlement(input.eventId)) ? 'duplicate' : 'retry' };
    }
    if (
      input.expectedOrganizationId !== undefined &&
      attempt.organizationId !== input.expectedOrganizationId
    ) {
      return { status: 'retry' };
    }

    return this.settle(attempt.organizationId, input.eventId, session);
  }

  /** Reconciles a positive read anchored to a reservation from the current organization. */
  public async recover(
    organizationId: string,
    providerKey: string,
    sessionId: string,
  ): Promise<'paid' | 'expired' | 'unknown'> {
    const session = await this.readTerminal(sessionId);
    if (session?.providerKey !== providerKey) return 'unknown';
    const result = await this.settle(organizationId, `checkout-poll:${sessionId}`, session);
    if (result.status === 'retry') return 'unknown';
    return session.status === 'expired' ? 'expired' : 'paid';
  }

  /** Validates the observed identity and mode before selecting any settlement scope. */
  private async readTerminal(
    sessionId: string,
  ): Promise<Exclude<StripeCheckoutSession, { readonly status: 'pending' }> | null> {
    const session = await this.sessions.retrieve(sessionId);
    if (
      session.status === 'pending' ||
      session.sessionId !== sessionId ||
      session.liveMode !== this.settings.liveMode ||
      session.providerKey.length === 0
    )
      return null;
    return session;
  }

  /** Reuses one transaction and decision for both webhook and recovery admission. */
  private async settle(
    organizationId: string,
    eventId: string,
    session: Exclude<StripeCheckoutSession, { readonly status: 'pending' }>,
  ): Promise<ReconcileStripeCheckoutOutput> {
    if (session.status === 'expired') {
      return {
        status: await this.settlement.settle({
          organizationId,
          eventId,
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
    });
    if (
      decision.kind !== 'apply' ||
      decision.plan !== 'team' ||
      subscription.items.length !== 1 ||
      subscription.items[0]?.priceId !== session.priceId ||
      subscription.items[0].quantity !== session.quantity
    )
      return { status: 'retry' };

    return {
      status: await this.settlement.settle({
        organizationId,
        eventId,
        session,
        decision,
      }),
    };
  }
  // #endregion
}

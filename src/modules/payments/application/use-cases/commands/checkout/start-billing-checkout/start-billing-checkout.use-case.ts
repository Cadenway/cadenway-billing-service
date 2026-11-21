import type { CheckoutProviderRequest } from '../../../../models/checkout/checkout-provider-request.model.js';
import type { CheckoutClaim } from '../../../../models/checkout/checkout-claim.model.js';
import type { CheckoutAuthority } from '../../../../ports/outbound/providers/checkout/checkout-authority.port.js';
import type { CheckoutProvider } from '../../../../ports/outbound/providers/checkout/checkout-provider.port.js';
import type { CheckoutUnitOfWork } from '../../../../ports/outbound/transactions/checkout/checkout-unit-of-work.port.js';
import type { ReconcileStripeCheckout } from '../reconcile-stripe-checkout/reconcile-stripe-checkout.use-case.js';
import type { StartBillingCheckoutInput } from './start-billing-checkout.input.js';
import type { StartBillingCheckoutOutput } from './start-billing-checkout.output.js';

const checkoutLifetimeSeconds = 2 * 60 * 60;

/** Creates or replays a tenant's hosted checkout without holding a transaction over provider I/O. */
export class StartBillingCheckout {
  // #region Constructor
  /** Binds durable reservations, authoritative seat reads and the Stripe provider. */
  public constructor(
    private readonly work: CheckoutUnitOfWork,
    private readonly authority: CheckoutAuthority,
    private readonly provider: CheckoutProvider,
    private readonly settleObservation: ReconcileStripeCheckout['recover'],
  ) {}
  // #endregion

  // #region Methods
  /** Reuses the original provider identity and parameters after an uncertain attempt. */
  public async execute(input: StartBillingCheckoutInput): Promise<StartBillingCheckoutOutput> {
    let claim: CheckoutClaim = await this.work.claim(input);
    if (claim.status === 'checkout-in-progress' || claim.status === 'unavailable') {
      const observed = await this.observe(input.organizationId).catch(() => ({
        status: 'unknown' as const,
      }));
      if (observed.status === 'paid') return { status: 'subscription-active' };
      if (observed.status === 'expired') claim = await this.work.claim(input);
    }
    if (claim.status === 'replay') return { status: 'ready', url: claim.url };
    if (claim.status !== 'claimed') return { status: claim.status };

    const outcome = await this.fulfillClaim(input, claim).catch((): StartBillingCheckoutOutput => ({
      status: 'unavailable',
    }));
    if (outcome.status !== 'ready') {
      await this.work.release(input.organizationId, claim.token);
    }
    return outcome;
  }

  /** Obtains a positive observation scoped by the reservation, without creating a session. */
  private async observe(
    organizationId: string,
    providerKey?: string,
  ): Promise<
    | { readonly status: 'paid' | 'expired' | 'terminal-pending' | 'unknown' }
    | { readonly status: 'open'; readonly sessionId: string; readonly url: string }
  > {
    const target = await this.work.findUnresolved(organizationId);
    if (
      target?.organizationId !== organizationId ||
      (providerKey !== undefined && providerKey !== target.providerKey)
    )
      return { status: 'unknown' };
    const evidence = await this.provider.recover(target);
    if (evidence.status !== 'terminal') return evidence;
    const terminal = await this.settleObservation(
      organizationId,
      target.providerKey,
      evidence.sessionId,
    );
    return { status: terminal === 'unknown' ? 'terminal-pending' : terminal };
  }

  /** Completes the original browser request or retries its immutable, still valid provider call. */
  private async fulfillClaim(
    input: StartBillingCheckoutInput,
    claim: Extract<CheckoutClaim, { readonly status: 'claimed' }>,
  ): Promise<StartBillingCheckoutOutput> {
    let request: CheckoutProviderRequest | null = claim.request;
    if (request !== null) {
      const observed = await this.observe(input.organizationId, claim.providerKey);
      if (observed.status === 'paid') return { status: 'subscription-active' };
      if (observed.status === 'expired' || observed.status === 'terminal-pending') {
        return { status: 'unavailable' };
      }
      if (observed.status === 'open') {
        return this.storeResponse(input.organizationId, claim.token, observed);
      }
    } else {
      const prepared = await this.authority.prepare(input.organizationId, claim.providerKey);
      if (prepared !== null) {
        request = {
          ...prepared,
          expiresAt: Math.floor(Date.now() / 1000) + checkoutLifetimeSeconds,
        };
      }
    }
    if (
      request?.expiresAt === undefined ||
      request.providerKey !== claim.providerKey ||
      request.organizationId !== input.organizationId ||
      !(await this.work.saveRequest(input.organizationId, claim.token, request))
    )
      return { status: 'unavailable' };
    return this.storeResponse(
      input.organizationId,
      claim.token,
      await this.provider.create(request),
    );
  }

  /** Returns a hosted URL only after the caller's lease commits that exact session. */
  private async storeResponse(
    organizationId: string,
    token: string,
    response: { readonly url: string; readonly sessionId: string },
  ): Promise<StartBillingCheckoutOutput> {
    const { url, sessionId } = response;
    return (await this.work.complete(organizationId, token, url, sessionId))
      ? { status: 'ready', url }
      : { status: 'unavailable' };
  }
  // #endregion
}

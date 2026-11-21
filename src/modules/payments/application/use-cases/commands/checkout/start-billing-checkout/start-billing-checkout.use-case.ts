import type { CheckoutProviderRequest } from '../../../../models/checkout/checkout-provider-request.model.js';
import type { CheckoutClaim } from '../../../../models/checkout/checkout-claim.model.js';
import type { CheckoutAuthority } from '../../../../ports/outbound/providers/checkout/checkout-authority.port.js';
import type { CheckoutProvider } from '../../../../ports/outbound/providers/checkout/checkout-provider.port.js';
import type { CheckoutUnitOfWork } from '../../../../ports/outbound/transactions/checkout/checkout-unit-of-work.port.js';
import type { StartBillingCheckoutInput } from './start-billing-checkout.input.js';
import type { StartBillingCheckoutOutput } from './start-billing-checkout.output.js';

/** Creates or replays a tenant's hosted checkout without holding a transaction over provider I/O. */
export class StartBillingCheckout {
  // #region Constructor
  /** Binds durable reservations, authoritative seat reads and the Stripe provider. */
  public constructor(
    private readonly work: CheckoutUnitOfWork,
    private readonly authority: CheckoutAuthority,
    private readonly provider: CheckoutProvider,
  ) {}
  // #endregion

  // #region Methods
  /** Reuses the original provider identity and parameters after an uncertain attempt. */
  public async execute(input: StartBillingCheckoutInput): Promise<StartBillingCheckoutOutput> {
    const claim: CheckoutClaim = await this.work.claim(input);
    if (claim.status === 'replay') return { status: 'ready', url: claim.url };
    if (claim.status !== 'claimed') return { status: claim.status };

    try {
      const request: CheckoutProviderRequest | null =
        claim.request ?? (await this.authority.prepare(input.organizationId, claim.providerKey));
      if (
        request?.providerKey !== claim.providerKey ||
        request.organizationId !== input.organizationId
      ) {
        await this.work.release(input.organizationId, claim.token);
        return { status: 'unavailable' };
      }
      if (!(await this.work.saveRequest(input.organizationId, claim.token, request))) {
        await this.work.release(input.organizationId, claim.token);
        return { status: 'unavailable' };
      }

      const url: string = await this.provider.create(request);
      if (!(await this.work.complete(input.organizationId, claim.token, url))) {
        return { status: 'unavailable' };
      }
      return { status: 'ready', url };
    } catch {
      await this.work.release(input.organizationId, claim.token);
      return { status: 'unavailable' };
    }
  }
  // #endregion
}

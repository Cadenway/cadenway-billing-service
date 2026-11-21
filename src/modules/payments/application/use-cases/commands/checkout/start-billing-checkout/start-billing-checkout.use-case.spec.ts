import { describe, expect, it, vi } from 'vitest';

import type { CheckoutClaim } from '../../../../models/checkout/checkout-claim.model.js';
import type { CheckoutProviderRequest } from '../../../../models/checkout/checkout-provider-request.model.js';
import type { CheckoutAuthority } from '../../../../ports/outbound/providers/checkout/checkout-authority.port.js';
import type { CheckoutProvider } from '../../../../ports/outbound/providers/checkout/checkout-provider.port.js';
import type { CheckoutUnitOfWork } from '../../../../ports/outbound/transactions/checkout/checkout-unit-of-work.port.js';
import type { StartBillingCheckoutInput } from './start-billing-checkout.input.js';
import { StartBillingCheckout } from './start-billing-checkout.use-case.js';

const input: StartBillingCheckoutInput = {
  organizationId: 'atelier-nord',
  actorId: 'camille',
  idempotencyKey: 'checkout-key',
  plan: 'team',
};

const request: CheckoutProviderRequest = {
  organizationId: input.organizationId,
  providerKey: 'provider-request-fixture',
  priceId: 'price-team-fixture',
  quantity: 5,
  successUrl: 'https://app.example.test/success',
  cancelUrl: 'https://app.example.test/cancel',
};

function fixture(
  claim: CheckoutClaim = {
    status: 'claimed',
    token: 'lease-a',
    providerKey: request.providerKey,
    request: null,
  },
): {
  readonly work: CheckoutUnitOfWork;
  readonly authority: CheckoutAuthority;
  readonly provider: CheckoutProvider;
  readonly useCase: StartBillingCheckout;
} {
  const work: CheckoutUnitOfWork = {
    claim: vi.fn().mockResolvedValue(claim),
    saveRequest: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const authority: CheckoutAuthority = { prepare: vi.fn().mockResolvedValue(request) };
  const provider: CheckoutProvider = {
    create: vi.fn().mockResolvedValue('https://checkout.example.test/one'),
  };
  return {
    work,
    authority,
    provider,
    useCase: new StartBillingCheckout(work, authority, provider),
  };
}

describe('StartBillingCheckout', () => {
  it('commits the trusted provider parameters before calling Stripe and records its response', async () => {
    const { work, authority, provider, useCase } = fixture();
    expect(await useCase.execute(input)).toEqual({
      status: 'ready',
      url: 'https://checkout.example.test/one',
    });
    expect(work.claim).toHaveBeenCalledExactlyOnceWith(input);
    expect(authority.prepare).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      request.providerKey,
    );
    expect(work.saveRequest).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      'lease-a',
      request,
    );
    expect(provider.create).toHaveBeenCalledExactlyOnceWith(request);
    expect(work.complete).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      'lease-a',
      'https://checkout.example.test/one',
    );
    expect(vi.mocked(work.saveRequest).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(provider.create).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('replays the committed response without calling Organization or Stripe', async () => {
    const { authority, provider, useCase } = fixture({
      status: 'replay',
      url: 'https://checkout.example.test/previous',
    });
    expect(await useCase.execute(input)).toEqual({
      status: 'ready',
      url: 'https://checkout.example.test/previous',
    });
    expect(authority.prepare).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it.each([
    'subscription-active',
    'checkout-in-progress',
    'request-in-progress',
    'key-reused',
    'unavailable',
  ] as const)('returns %s without starting a provider request', async (status) => {
    const { authority, provider, useCase } = fixture({ status });
    expect(await useCase.execute(input)).toEqual({ status });
    expect(authority.prepare).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('retries an uncertain call using precisely the previously stored provider parameters', async () => {
    const { authority, provider, work, useCase } = fixture({
      status: 'claimed',
      token: 'lease-b',
      providerKey: request.providerKey,
      request,
    });
    expect(await useCase.execute(input)).toMatchObject({ status: 'ready' });
    expect(authority.prepare).not.toHaveBeenCalled();
    expect(work.saveRequest).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      'lease-b',
      request,
    );
    expect(provider.create).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('does not retry a stored request when the final authorization refuses dispatch', async () => {
    const { work, authority, provider, useCase } = fixture({
      status: 'claimed',
      token: 'lease-b',
      providerKey: request.providerKey,
      request,
    });
    vi.mocked(work.saveRequest).mockResolvedValue(false);

    expect(await useCase.execute(input)).toEqual({ status: 'unavailable' });
    expect(work.release).toHaveBeenCalledExactlyOnceWith(input.organizationId, 'lease-b');
    expect(authority.prepare).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('retains the reservation after a provider timeout for a retry using the same identity', async () => {
    const { work, provider, useCase } = fixture();
    vi.mocked(provider.create).mockRejectedValue(new Error('timeout'));
    expect(await useCase.execute(input)).toEqual({ status: 'unavailable' });
    expect(work.complete).not.toHaveBeenCalled();
    expect(work.release).toHaveBeenCalledExactlyOnceWith(input.organizationId, 'lease-a');
  });

  it('refuses a seat result scoped to a different organization', async () => {
    const { authority, work, provider, useCase } = fixture();
    vi.mocked(authority.prepare).mockResolvedValue({ ...request, organizationId: 'other-tenant' });
    expect(await useCase.execute(input)).toEqual({ status: 'unavailable' });
    expect(work.saveRequest).not.toHaveBeenCalled();
    expect(work.release).toHaveBeenCalledOnce();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('does not call Stripe if the lease expires before parameters are recorded', async () => {
    const { work, provider, useCase } = fixture();
    vi.mocked(work.saveRequest).mockResolvedValue(false);
    expect(await useCase.execute(input)).toEqual({ status: 'unavailable' });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('does not expose a URL when an expired lease cannot commit its response', async () => {
    const { work, useCase } = fixture();
    vi.mocked(work.complete).mockResolvedValue(false);
    expect(await useCase.execute(input)).toEqual({ status: 'unavailable' });
  });
});

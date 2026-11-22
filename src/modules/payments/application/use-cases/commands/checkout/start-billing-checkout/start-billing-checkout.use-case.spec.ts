import { describe, expect, it, vi } from 'vitest';

import type { CheckoutClaim } from '../../../../models/checkout/checkout-claim.model.js';
import type { CheckoutProviderRequest } from '../../../../models/checkout/checkout-provider-request.model.js';
import type { CheckoutRecoveryTarget } from '../../../../models/checkout/checkout-recovery-target.model.js';
import type { FirstCheckoutDispatch } from '../../../../models/checkout/first-checkout-dispatch.model.js';
import type { CheckoutAuthority } from '../../../../ports/outbound/providers/checkout/checkout-authority.port.js';
import type { CheckoutProvider } from '../../../../ports/outbound/providers/checkout/checkout-provider.port.js';
import type { CheckoutUnitOfWork } from '../../../../ports/outbound/transactions/checkout/checkout-unit-of-work.port.js';
import type { ReconcileStripeCheckout } from '../reconcile-stripe-checkout/reconcile-stripe-checkout.use-case.js';
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

const requestedAt = new Date('2026-11-21T12:00:00.000Z');
const expiresAt = requestedAt.getTime() / 1000 + 7200;
const savedRequest = { ...request, expiresAt };
const opened = { sessionId: 'cs_fixture', url: 'https://checkout.example.test/one' };
const firstDispatch: FirstCheckoutDispatch = { status: 'first-dispatch', version: 3 };
const unresolved: CheckoutRecoveryTarget = {
  organizationId: input.organizationId,
  providerKey: request.providerKey,
  providerStartedAt: requestedAt,
  sessionId: null,
  priceId: request.priceId,
  quantity: request.quantity,
  expiresAt,
};

function recoveryClaim(previous: CheckoutProviderRequest = savedRequest): CheckoutClaim {
  return {
    status: 'claimed',
    token: 'lease-b',
    providerKey: previous.providerKey,
    request: previous,
  };
}

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
  readonly settleObservation: ReconcileStripeCheckout['recover'];
  readonly useCase: StartBillingCheckout;
} {
  const work: CheckoutUnitOfWork = {
    claim: vi.fn().mockResolvedValue(claim),
    saveRequest: vi
      .fn()
      .mockResolvedValue(
        claim.status === 'claimed' && claim.request === null ? firstDispatch : { status: 'retry' },
      ),
    resolveRejected: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    findUnresolved: vi.fn().mockResolvedValue(null),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const authority: CheckoutAuthority = { prepare: vi.fn().mockResolvedValue(request) };
  const provider: CheckoutProvider = {
    create: vi.fn().mockResolvedValue(opened),
    recover: vi.fn().mockResolvedValue({ status: 'unknown' }),
  };
  const settleObservation = vi
    .fn<ReconcileStripeCheckout['recover']>()
    .mockResolvedValue('unknown');
  return {
    work,
    authority,
    provider,
    settleObservation,
    useCase: new StartBillingCheckout(work, authority, provider, settleObservation),
  };
}

describe('StartBillingCheckout', () => {
  it('commits the trusted provider parameters before calling Stripe and records its response', async () => {
    const { work, authority, provider, useCase } = fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(requestedAt.getTime());
    try {
      expect(await useCase.execute(input)).toEqual({ status: 'ready', url: opened.url });
    } finally {
      clock.mockRestore();
    }
    expect(work.claim).toHaveBeenCalledExactlyOnceWith(input);
    expect(authority.prepare).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      request.providerKey,
    );
    expect(work.saveRequest).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      'lease-a',
      savedRequest,
    );
    expect(provider.create).toHaveBeenCalledExactlyOnceWith(savedRequest);
    expect(work.complete).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      'lease-a',
      opened.url,
      opened.sessionId,
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
    expect(provider.recover).not.toHaveBeenCalled();
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
    const { authority, provider, work, useCase } = fixture(recoveryClaim());
    vi.mocked(work.findUnresolved).mockResolvedValue(unresolved);
    expect(await useCase.execute(input)).toMatchObject({ status: 'ready' });
    expect(work.claim).toHaveBeenCalledExactlyOnceWith(input);
    expect(authority.prepare).not.toHaveBeenCalled();
    expect(provider.recover).toHaveBeenCalledExactlyOnceWith(unresolved);
    expect(work.saveRequest).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      'lease-b',
      savedRequest,
    );
    expect(provider.create).toHaveBeenCalledExactlyOnceWith(savedRequest);
  });

  it('does not retry a stored request when the final authorization refuses dispatch', async () => {
    const { work, authority, provider, useCase } = fixture(recoveryClaim());
    vi.mocked(work.saveRequest).mockResolvedValue(null);

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
    expect(work.resolveRejected).not.toHaveBeenCalled();
    expect(work.release).toHaveBeenCalledExactlyOnceWith(input.organizationId, 'lease-a');
  });

  it('resolves a proven first rejection using the exact committed dispatch', async () => {
    const { work, provider, useCase } = fixture();
    vi.mocked(provider.create).mockResolvedValue({ status: 'rejected-before-execution' });

    await expect(useCase.execute(input)).resolves.toEqual({ status: 'unavailable' });
    expect(work.resolveRejected).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      'lease-a',
      request.providerKey,
      firstDispatch,
    );
    expect(work.complete).not.toHaveBeenCalled();
  });

  it('keeps a stored request reserved when its retry receives a price rejection', async () => {
    const { work, provider, useCase } = fixture(recoveryClaim());
    vi.mocked(work.findUnresolved).mockResolvedValue(unresolved);
    vi.mocked(provider.create).mockResolvedValue({ status: 'rejected-before-execution' });

    await expect(useCase.execute(input)).resolves.toEqual({ status: 'unavailable' });
    expect(provider.create).toHaveBeenCalledExactlyOnceWith(savedRequest);
    expect(work.resolveRejected).not.toHaveBeenCalled();
    expect(work.complete).not.toHaveBeenCalled();
    expect(work.release).toHaveBeenCalledExactlyOnceWith(input.organizationId, 'lease-b');
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
    vi.mocked(work.saveRequest).mockResolvedValue(null);
    expect(await useCase.execute(input)).toEqual({ status: 'unavailable' });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('does not expose a URL when an expired lease cannot commit its response', async () => {
    const { work, useCase } = fixture();
    vi.mocked(work.complete).mockResolvedValue(false);
    expect(await useCase.execute(input)).toEqual({ status: 'unavailable' });
  });

  it('commits the recovered open session for a retry with the original key', async () => {
    const { work, provider, useCase } = fixture(recoveryClaim());
    vi.mocked(work.findUnresolved).mockResolvedValue(unresolved);
    vi.mocked(provider.recover).mockResolvedValue({ status: 'open', ...opened });

    await expect(useCase.execute(input)).resolves.toEqual({ status: 'ready', url: opened.url });
    expect(work.claim).toHaveBeenCalledExactlyOnceWith(input);
    expect(work.complete).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      'lease-b',
      opened.url,
      opened.sessionId,
    );
    expect(work.saveRequest).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, idempotencyKey: 'another-key' },
    { ...input, actorId: 'another-owner' },
  ])('keeps a recovered open URL private to the original actor and key', async (otherInput) => {
    const { work, provider, useCase } = fixture({ status: 'checkout-in-progress' });
    vi.mocked(work.findUnresolved).mockResolvedValue(unresolved);
    vi.mocked(provider.recover).mockResolvedValue({ status: 'open', ...opened });

    await expect(useCase.execute(otherInput)).resolves.toEqual({ status: 'checkout-in-progress' });
    expect(work.claim).toHaveBeenCalledExactlyOnceWith(otherInput);
    expect(provider.recover).toHaveBeenCalledExactlyOnceWith(unresolved);
    expect(work.complete).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('keeps a recovered open URL private if another contender has invalidated the lease', async () => {
    const { work, provider, useCase } = fixture(recoveryClaim());
    vi.mocked(work.findUnresolved).mockResolvedValue(unresolved);
    vi.mocked(provider.recover).mockResolvedValue({ status: 'open', ...opened });
    vi.mocked(work.complete).mockResolvedValue(false);

    await expect(useCase.execute(input)).resolves.toEqual({ status: 'unavailable' });
    expect(work.release).toHaveBeenCalledExactlyOnceWith(input.organizationId, 'lease-b');
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('claims and creates once using a new key only after settling the prior expiration', async () => {
    const { work, authority, provider, settleObservation, useCase } = fixture({
      status: 'checkout-in-progress',
    });
    const nextInput = { ...input, idempotencyKey: 'another-key' };
    const providerKey = 'provider-request-next';
    vi.mocked(work.findUnresolved).mockResolvedValue(unresolved);
    vi.mocked(provider.recover).mockResolvedValue({
      status: 'terminal',
      sessionId: opened.sessionId,
    });
    vi.mocked(settleObservation).mockResolvedValue('expired');
    vi.mocked(work.claim)
      .mockResolvedValueOnce({ status: 'checkout-in-progress' })
      .mockResolvedValueOnce({
        status: 'claimed',
        token: 'lease-next',
        providerKey,
        request: null,
      });
    vi.mocked(authority.prepare).mockResolvedValue({ ...request, providerKey });

    await expect(useCase.execute(nextInput)).resolves.toEqual({ status: 'ready', url: opened.url });
    expect(settleObservation).toHaveBeenCalledExactlyOnceWith(
      input.organizationId,
      unresolved.providerKey,
      opened.sessionId,
    );
    expect(work.claim).toHaveBeenCalledTimes(2);
    expect(work.claim).toHaveBeenNthCalledWith(2, nextInput);
    expect(vi.mocked(settleObservation).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(work.claim).mock.invocationCallOrder[1] ?? 0,
    );
    expect(provider.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerKey }),
    );
  });

  it('keeps an uncertain request fenced when a contender wins the claim after expiration', async () => {
    const { work, provider, settleObservation, useCase } = fixture({
      status: 'checkout-in-progress',
    });
    vi.mocked(work.findUnresolved).mockResolvedValue(unresolved);
    vi.mocked(provider.recover).mockResolvedValue({
      status: 'terminal',
      sessionId: opened.sessionId,
    });
    vi.mocked(settleObservation).mockResolvedValue('expired');

    await expect(useCase.execute(input)).resolves.toEqual({ status: 'checkout-in-progress' });
    expect(work.claim).toHaveBeenCalledTimes(2);
    expect(provider.recover).toHaveBeenCalledOnce();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('reports the paid subscription after recovery and makes no Stripe write', async () => {
    const { work, provider, settleObservation, useCase } = fixture({
      status: 'checkout-in-progress',
    });
    vi.mocked(work.findUnresolved).mockResolvedValue(unresolved);
    vi.mocked(provider.recover).mockResolvedValue({
      status: 'terminal',
      sessionId: opened.sessionId,
    });
    vi.mocked(settleObservation).mockResolvedValue('paid');

    await expect(useCase.execute(input)).resolves.toEqual({ status: 'subscription-active' });
    expect(work.claim).toHaveBeenCalledOnce();
    expect(work.complete).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('makes no new provider request for a legacy reservation without positive evidence', async () => {
    const { work, provider, settleObservation, useCase } = fixture(recoveryClaim(request));
    vi.mocked(work.findUnresolved).mockResolvedValue({ ...unresolved, expiresAt: undefined });
    vi.mocked(provider.recover).mockResolvedValue({ status: 'unknown' });

    await expect(useCase.execute(input)).resolves.toEqual({ status: 'unavailable' });
    expect(provider.recover).toHaveBeenCalledOnce();
    expect(settleObservation).not.toHaveBeenCalled();
    expect(work.saveRequest).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('holds the original reservation when recovery cannot confirm a terminal state', async () => {
    const { work, provider, settleObservation, useCase } = fixture({
      status: 'checkout-in-progress',
    });
    vi.mocked(work.findUnresolved).mockResolvedValue(unresolved);
    vi.mocked(provider.recover).mockResolvedValue({
      status: 'terminal',
      sessionId: opened.sessionId,
    });
    vi.mocked(settleObservation).mockResolvedValue('unknown');

    await expect(useCase.execute(input)).resolves.toEqual({ status: 'checkout-in-progress' });
    expect(work.claim).toHaveBeenCalledOnce();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('does not send a create request when the original session is terminal but settlement is pending', async () => {
    const { work, provider, settleObservation, useCase } = fixture(recoveryClaim());
    vi.mocked(work.findUnresolved).mockResolvedValue(unresolved);
    vi.mocked(provider.recover).mockResolvedValue({
      status: 'terminal',
      sessionId: opened.sessionId,
    });
    vi.mocked(settleObservation).mockResolvedValue('unknown');

    await expect(useCase.execute(input)).resolves.toEqual({ status: 'unavailable' });
    expect(work.release).toHaveBeenCalledExactlyOnceWith(input.organizationId, 'lease-b');
    expect(work.saveRequest).not.toHaveBeenCalled();
    expect(work.complete).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });
});

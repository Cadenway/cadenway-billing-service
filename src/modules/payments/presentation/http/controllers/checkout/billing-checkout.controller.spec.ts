import { StartBillingCheckoutInternalBody } from '@cadenway/contracts/validators/internal/billing-service';
import {
  ProblemException,
  runWithOrganizationContext,
  ZodValidationPipe,
} from '@cadenway/nest-common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { StartBillingCheckout } from '../../../../application/use-cases/commands/checkout/start-billing-checkout/start-billing-checkout.use-case.js';

import { BillingCheckoutController } from './billing-checkout.controller.js';

const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const actorId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';
const context = {
  organizationId,
  actor: { type: 'user' as const, id: actorId },
  role: null,
  scopes: [],
};
const request = (keys: string[] = ['checkout-key']): Request =>
  ({
    headersDistinct: { 'idempotency-key': keys },
    internalPrincipal: context,
  }) as unknown as Request;

describe('BillingCheckoutController', () => {
  it('uses the signed actor and tenant with the unchanged idempotency key', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ status: 'ready', url: 'https://checkout.example.test/session' });
    const controller = new BillingCheckoutController({
      execute,
    } as unknown as StartBillingCheckout);
    const response = await runWithOrganizationContext(context, () =>
      controller.post(request(), { plan: 'team' }, {}),
    );
    expect(execute).toHaveBeenCalledWith({
      organizationId,
      actorId,
      idempotencyKey: 'checkout-key',
      plan: 'team',
    });
    expect(response).toEqual({ url: 'https://checkout.example.test/session' });
  });

  it.each([
    ['subscription-active', 409, 'billing.subscription-active'],
    ['checkout-in-progress', 409, 'billing.checkout-in-progress'],
    ['request-in-progress', 409, 'idempotency.request-in-progress'],
    ['key-reused', 422, 'idempotency.key-reused'],
    ['unavailable', 503, 'billing.unavailable'],
  ])('maps %s to the contracted problem', async (outcome, status, code) => {
    const execute = vi.fn().mockResolvedValue({ status: outcome });
    const controller = new BillingCheckoutController({
      execute,
    } as unknown as StartBillingCheckout);
    await expect(
      runWithOrganizationContext(context, () => controller.post(request(), { plan: 'team' }, {})),
    ).rejects.toMatchObject({ status, response: { code } });
  });

  it.each([
    { keys: [] },
    { keys: [''] },
    { keys: ['has space'] },
    { keys: ['x'.repeat(256)] },
    { keys: ['first', 'second'] },
  ])('rejects invalid or duplicate keys %o', async ({ keys }) => {
    const execute = vi.fn();
    const controller = new BillingCheckoutController({
      execute,
    } as unknown as StartBillingCheckout);
    await expect(
      runWithOrganizationContext(context, () =>
        controller.post(request(keys), { plan: 'team' }, {}),
      ),
    ).rejects.toMatchObject({ status: 400, response: { code: 'request.invalid' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses disabled checkout and hides invalid provider responses', async () => {
    const disabled = new BillingCheckoutController(null);
    await expect(
      runWithOrganizationContext(context, () => disabled.post(request(), { plan: 'team' }, {})),
    ).rejects.toMatchObject({ status: 503, response: { code: 'billing.unavailable' } });
    const execute = vi
      .fn()
      .mockResolvedValue({ status: 'ready', url: 'http://unsafe.example.test' });
    const invalid = new BillingCheckoutController({ execute } as unknown as StartBillingCheckout);
    await expect(
      runWithOrganizationContext(context, () => invalid.post(request(), { plan: 'team' }, {})),
    ).rejects.toMatchObject({ status: 503, response: { code: 'billing.unavailable' } });
  });

  it('maps provider failures to an opaque problem', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('private provider data'));
    const controller = new BillingCheckoutController({
      execute,
    } as unknown as StartBillingCheckout);
    await expect(
      runWithOrganizationContext(context, () => controller.post(request(), { plan: 'team' }, {})),
    ).rejects.toMatchObject({ status: 503, response: { code: 'billing.unavailable' } });
  });
});

describe('checkout body validation', () => {
  const pipe = new ZodValidationPipe(StartBillingCheckoutInternalBody);
  const metadata = { type: 'body' as const, metatype: Object };

  it.each([{}, { plan: 'free' }, { plan: 'team', organizationId: 'other' }])(
    'rejects %o',
    (body) => {
      expect(() => pipe.transform(body, metadata)).toThrow(ProblemException);
    },
  );
});

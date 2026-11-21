import {
  ProblemException,
  runWithOrganizationContext,
  ZodValidationPipe,
} from '@cadenway/nest-common';
import { describe, expect, it, vi } from 'vitest';

import type { GetBillingSubscription } from '../../../../application/use-cases/queries/subscription/get-billing-subscription/get-billing-subscription.use-case.js';
import { billingSubscriptionQuery } from '../../validation/subscription/billing-subscription-query.validation.js';

import { BillingSubscriptionController } from './billing-subscription.controller.js';

const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const context = {
  organizationId,
  actor: { type: 'user' as const, id: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24' },
  role: null,
  scopes: [],
};
const subscription = {
  plan: 'free',
  seats: { used: 4, limit: 5 },
  guestCount: 2,
  storage: { attachmentBytesUsed: 1_600_000_000, limitBytes: 2_000_000_000 },
} as const;

describe('BillingSubscriptionController', () => {
  it('uses the verified tenant and exposes only fields declared by the installed contract', async () => {
    const execute = vi.fn().mockResolvedValue({ ...subscription, internalMarker: 'private' });
    const controller = new BillingSubscriptionController({
      execute,
    } as unknown as GetBillingSubscription);

    const result = await runWithOrganizationContext(context, () => controller.get({}));

    expect(execute).toHaveBeenCalledWith({ organizationId });
    expect(result).toEqual(subscription);
  });

  it.each([
    ['uninitialized usage', () => Promise.resolve(null)],
    ['invalid usage', () => Promise.resolve({ ...subscription, guestCount: -1 })],
    ['repository failure', () => Promise.reject(new Error('private database details'))],
  ])('returns the same safe unavailable problem for %s', async (_reason, execute) => {
    const controller = new BillingSubscriptionController({
      execute,
    } as unknown as GetBillingSubscription);

    await expect(
      runWithOrganizationContext(context, () => controller.get({})),
    ).rejects.toMatchObject({ status: 503, response: { code: 'billing.unavailable' } });
  });

  it('cannot construct the tenant from input when no verified organization context exists', async () => {
    const execute = vi.fn();
    const controller = new BillingSubscriptionController({
      execute,
    } as unknown as GetBillingSubscription);

    await expect(controller.get({})).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('subscription query validation', () => {
  const pipe = new ZodValidationPipe(billingSubscriptionQuery);
  const metadata = { type: 'query' as const, metatype: Object };

  it('accepts no query parameters and refuses unknown parameters with a contracted issue', () => {
    expect(pipe.transform({}, metadata)).toEqual({});
    try {
      pipe.transform({ unexpected: 'value' }, metadata);
      throw new Error('Expected an invalid query.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProblemException);
      if (!(error instanceof ProblemException)) throw error;
      expect(error.problem).toMatchObject({
        status: 400,
        code: 'request.invalid',
        details: { issues: [{ in: 'query', path: 'unexpected', code: 'unrecognized_parameter' }] },
      });
    }
  });
});

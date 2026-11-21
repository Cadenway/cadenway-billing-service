import { runWithOrganizationContext, type OrganizationContext } from '@cadenway/nest-common';
import { SystemTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { DrizzleStripeWebhookBindingReader } from './drizzle-stripe-webhook-binding.repository.js';

const context: OrganizationContext = {
  organizationId: null,
  actor: { type: 'system', id: 'api-gateway' },
  role: null,
  scopes: [],
};
const identity = {
  account: null,
  authContext: null,
  customerId: 'cus_local',
  subscriptionId: 'sub_local',
};

describe('Stripe webhook binding context', () => {
  let pool: pg.Pool;
  let query: MockInstance<SystemTransactionRunner<DatabaseSchema>['run']>;
  let reader: DrizzleStripeWebhookBindingReader;

  beforeEach(() => {
    pool = new pg.Pool();
    const runner = new SystemTransactionRunner<DatabaseSchema>(pool);
    query = vi.spyOn(runner, 'run').mockRejectedValue(new Error('Unexpected binding query.'));
    reader = new DrizzleStripeWebhookBindingReader(runner);
  });

  afterEach(async () => {
    await pool.end();
  });

  it.each([
    { account: 'acct_other' },
    { authContext: 'acct_other' },
    { customerId: '' },
    { subscriptionId: ' ' },
    { customerId: 'cus_\0invalid' },
    { subscriptionId: 's'.repeat(256) },
  ])(
    'returns no match for an unsupported account or malformed pair without querying',
    async (parts) => {
      await expect(
        runWithOrganizationContext(context, () => reader.resolve({ ...identity, ...parts })),
      ).resolves.toBeNull();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('refuses a global user context before querying', async () => {
    await expect(
      runWithOrganizationContext(
        { ...context, actor: { type: 'user', id: '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e11' } },
        () => reader.resolve(identity),
      ),
    ).rejects.toThrow('global system actor');
    expect(query).not.toHaveBeenCalled();
  });
});

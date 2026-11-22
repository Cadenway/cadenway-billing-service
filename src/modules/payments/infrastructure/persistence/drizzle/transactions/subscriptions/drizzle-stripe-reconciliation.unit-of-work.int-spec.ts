import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { runWithOrganizationContext, type OrganizationContext } from '@cadenway/nest-common';
import {
  SystemTransactionRunner,
  TenantTransactionRunner,
  type DatabaseSchema,
} from '@cadenway/nest-common/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { StripeReconciliationTransaction } from '../../../../../application/ports/outbound/transactions/subscriptions/stripe-reconciliation-transaction.port.js';
import { ReconcileStripeSubscription } from '../../../../../application/use-cases/commands/subscriptions/reconcile-stripe-subscription/reconcile-stripe-subscription.use-case.js';
import { DrizzleStripeBindingReader } from '../../repositories/subscriptions/drizzle-stripe-binding.repository.js';
import { DrizzleStripeWebhookBindingReader } from '../../repositories/subscriptions/drizzle-stripe-webhook-binding.repository.js';
import { DrizzleStripeReconciliationUnitOfWork } from './drizzle-stripe-reconciliation.unit-of-work.js';
import { StripeEntitlementOutboxFence } from './stripe-entitlement-outbox-fence.transaction.js';
import type { StripeEntitlementFence } from './stripe-entitlement-fence.transaction.js';

const project = `cadenway-billing-stripe-test-${String(process.pid)}`;
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e11';
const secondBoundId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e12';
const localIdentity = {
  account: null,
  authContext: null,
  customerId: 'cus_local',
  subscriptionId: 'sub_local',
};
const verifiedWebhookCaller: OrganizationContext = {
  organizationId: null,
  actor: { type: 'system', id: 'api-gateway' },
  role: null,
  scopes: [],
};
const team = {
  kind: 'apply' as const,
  plan: 'team' as const,
  limits: { seats: 8, storageBytes: 100_000_000_000 },
  scheduledCancellation: false,
};

function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', 'compose.dev.yaml', ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0', DEV_NATS_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function context(organization: string): OrganizationContext {
  return {
    organizationId: organization,
    actor: { type: 'system', id: 'billing-service' },
    role: null,
    scopes: [],
  };
}

describe('Stripe reconciliation PostgreSQL transactions', () => {
  let migrator: pg.Pool | undefined;
  let application: pg.Pool | undefined;
  let runner: TenantTransactionRunner<DatabaseSchema>;
  let webhookBindings: DrizzleStripeWebhookBindingReader;
  let started = false;
  const inTenant = <T>(organization: string, work: () => Promise<T>): Promise<T> =>
    runWithOrganizationContext(context(organization), work);

  beforeAll(async () => {
    started = true;
    compose('up', '--detach', '--wait', '--wait-timeout', '120', 'postgres');
    const port = compose('port', 'postgres', '5432').trim().split(':').at(-1);
    if (port === undefined) throw new Error('PostgreSQL port was not published.');
    migrator = new pg.Pool({
      connectionString: `postgres://billing_migrator:billing_migrator@127.0.0.1:${port}/billing`,
    });
    await migrate(drizzle({ client: migrator }), { migrationsFolder: resolve('migrations') });
    application = new pg.Pool({
      connectionString: `postgres://billing_app:billing_app@127.0.0.1:${port}/billing`,
      max: 5,
    });
    runner = new TenantTransactionRunner<DatabaseSchema>(application);
    webhookBindings = new DrizzleStripeWebhookBindingReader(
      new SystemTransactionRunner<DatabaseSchema>(application),
    );
    await inTenant(organizationId, () =>
      runner.run(async ({ client }) => {
        await client.query(
          'insert into stripe_bindings (organization_id, customer_id, subscription_id) values ($1, $2, $3)',
          [organizationId, 'cus_local', 'sub_local'],
        );
      }),
    );
  });

  afterAll(async () => {
    try {
      await application?.end();
      await migrator?.end();
    } finally {
      if (started) compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('rolls back the entitlement and receipt together, then settles once under a tenant lock', async () => {
    const fence: StripeEntitlementFence = {
      authorizeChange: vi.fn().mockResolvedValue(true),
    };
    const unit = new DrizzleStripeReconciliationUnitOfWork(runner, fence);
    const bindings = new DrizzleStripeBindingReader(runner);
    await expect(
      inTenant(organizationId, () =>
        unit.run(organizationId, async (tx) => {
          await tx.lockBinding();
          expect(await tx.apply(team)).toBe('applied');
          await tx.settle('evt_rollback');
          throw new Error('rollback');
        }),
      ),
    ).rejects.toThrow('rollback');
    expect(await inTenant(organizationId, () => bindings.read(organizationId))).toEqual({
      revision: 1,
      binding: { customerId: 'cus_local', subscriptionId: 'sub_local' },
    });
    const settle = () =>
      inTenant(organizationId, () =>
        unit.run(organizationId, async (tx) => {
          await tx.lockBinding();
          if (await tx.isSettled('evt_one')) return 'duplicate';
          const outcome = await tx.apply(team);
          await tx.settle('evt_one');
          return outcome;
        }),
      );
    expect((await Promise.all([settle(), settle()])).sort()).toEqual(['applied', 'duplicate']);
    expect(await inTenant(organizationId, () => bindings.read(organizationId))).toMatchObject({
      revision: 2,
    });
    expect(await inTenant(otherId, () => bindings.read(otherId))).toBeNull();
    await expect(inTenant(otherId, () => bindings.read(organizationId))).rejects.toThrow(
      'tenant scope',
    );

    const retrieve = vi.fn().mockRejectedValue(new Error('Stripe is unavailable.'));
    const reconcile = new ReconcileStripeSubscription(bindings, { retrieve }, unit, {
      liveMode: false,
      teamPriceIds: ['price_team'],
      freePlanLimits: { seats: 5, storageBytes: 2_000_000_000 },
    });
    await expect(
      inTenant(organizationId, () =>
        reconcile.execute({
          organizationId,
          eventId: 'evt_one',
          acceptedBinding: {
            revision: 1,
            binding: { customerId: 'cus_local', subscriptionId: 'sub_local' },
          },
        }),
      ),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(retrieve).not.toHaveBeenCalled();
    await expect(
      inTenant(otherId, () => unit.run(otherId, (transaction) => transaction.isSettled('evt_one'))),
    ).resolves.toBe(false);
    await expect(
      runWithOrganizationContext(verifiedWebhookCaller, () =>
        webhookBindings.hasSettlement('evt_one'),
      ),
    ).resolves.toBe(true);
    await expect(inTenant(otherId, () => webhookBindings.hasSettlement('evt_one'))).rejects.toThrow(
      'global system actor',
    );
  });

  it('does not settle a change without the admission fence', async () => {
    const unit = new DrizzleStripeReconciliationUnitOfWork(runner, {
      authorizeChange: () => Promise.resolve(false),
    });
    const result = await inTenant(organizationId, () =>
      unit.run(organizationId, async (tx) => {
        await tx.lockBinding();
        return await tx.apply({ ...team, limits: { ...team.limits, seats: 9 } });
      }),
    );
    expect(result).toBe('deferred');
    expect(
      await inTenant(organizationId, () =>
        new DrizzleStripeBindingReader(runner).read(organizationId),
      ),
    ).toMatchObject({ revision: 2 });
  });

  it('resolves the exact provider pair and returns the live revision only for a global system actor', async () => {
    await inTenant(secondBoundId, () =>
      runner.run(async ({ client }) => {
        await client.query(
          'insert into stripe_bindings (organization_id, customer_id, subscription_id) values ($1, $2, $3)',
          [secondBoundId, 'cus_other', 'sub_other'],
        );
      }),
    );
    const snapshot = await inTenant(organizationId, () =>
      new DrizzleStripeBindingReader(runner).read(organizationId),
    );
    const read = (identity: Parameters<DrizzleStripeWebhookBindingReader['resolve']>[0]) =>
      runWithOrganizationContext(verifiedWebhookCaller, () => webhookBindings.resolve(identity));

    expect(await read(localIdentity)).toEqual({ organizationId, ...snapshot });
    expect(await read({ ...localIdentity, customerId: 'cus_other' })).toBeNull();
    expect(await read({ ...localIdentity, subscriptionId: 'sub_other' })).toBeNull();
    expect(await read({ ...localIdentity, subscriptionId: 'sub_missing' })).toBeNull();
    expect(await read({ ...localIdentity, customerId: 'cus_Local' })).toBeNull();
    await expect(
      inTenant(organizationId, () => webhookBindings.resolve(localIdentity)),
    ).rejects.toThrow('global system actor');
    await expect(webhookBindings.resolve(localIdentity)).rejects.toThrow('global system actor');
  });

  it.each([
    { customerId: 'cus_local', subscriptionId: 'sub_distinct' },
    { customerId: 'cus_distinct', subscriptionId: 'sub_local' },
  ])('prevents another tenant claiming either bound provider identity', async (identity) => {
    await expect(
      inTenant(otherId, () =>
        runner.run(({ client }) =>
          client.query(
            'insert into stripe_bindings (organization_id, customer_id, subscription_id) values ($1, $2, $3)',
            [otherId, identity.customerId, identity.subscriptionId],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(
      await inTenant(otherId, () => new DrizzleStripeBindingReader(runner).read(otherId)),
    ).toBeNull();
  });

  it('rolls back a receipt collision across tenants even if their bindings are distinct', async () => {
    const unit = new DrizzleStripeReconciliationUnitOfWork(runner, {
      authorizeChange: () => Promise.resolve(true),
    });
    await expect(
      inTenant(secondBoundId, () =>
        unit.run(secondBoundId, async (tx) => {
          expect(await tx.lockBinding()).not.toBeNull();
          expect(await tx.isSettled('evt_one')).toBe(false);
          expect(await tx.apply(team)).toBe('applied');
          await tx.settle('evt_one');
        }),
      ),
    ).rejects.toThrow();
    expect(
      await inTenant(secondBoundId, () =>
        new DrizzleStripeBindingReader(runner).read(secondBoundId),
      ),
    ).toMatchObject({ revision: 1 });
    const snapshots = await inTenant(secondBoundId, () =>
      runner.run(({ client }) =>
        client.query(
          'select organization_id from stripe_subscription_snapshots where organization_id = $1',
          [secondBoundId],
        ),
      ),
    );
    expect(snapshots.rows).toEqual([]);
  });

  it('returns to canonical Free once and keeps that snapshot for the canceled binding', async () => {
    const organization = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e13';
    await inTenant(organization, () =>
      runner.run(({ client }) =>
        client.query(
          'insert into stripe_bindings (organization_id, customer_id, subscription_id) values ($1, $2, $3)',
          [organization, 'cus_canceled', 'sub_canceled'],
        ),
      ),
    );
    const append = vi.fn().mockResolvedValue(undefined);
    const baseline = { seatLimit: 5, storageByteLimit: 2_000_000_000 };
    const unit = new DrizzleStripeReconciliationUnitOfWork(
      runner,
      new StripeEntitlementOutboxFence(baseline, { append }, true),
    );
    const free = {
      kind: 'apply' as const,
      plan: 'free' as const,
      limits: { seats: 5, storageBytes: 2_000_000_000 },
    };
    const apply = (
      decision: Parameters<StripeReconciliationTransaction['apply']>[0],
      eventId: string,
    ) =>
      inTenant(organization, () =>
        unit.run(organization, async (tx) => {
          expect(await tx.lockBinding()).not.toBeNull();
          const result = await tx.apply(decision);
          if (result !== 'deferred') await tx.settle(eventId);
          return result;
        }),
      );

    await expect(apply(team, 'evt_paid_team')).resolves.toBe('applied');
    await expect(
      apply({ ...team, limits: { ...team.limits, seats: 7 } }, 'evt_lower_team'),
    ).resolves.toBe('deferred');
    await expect(
      apply({ ...free, limits: { ...free.limits, seats: 6 } }, 'evt_noncanonical_free'),
    ).resolves.toBe('deferred');
    await expect(apply(free, 'evt_cancel_team')).resolves.toBe('applied');
    await expect(apply(free, 'evt_unchanged_cancel')).resolves.toBe('unchanged');
    await expect(apply(team, 'evt_stale_team')).resolves.toBe('unchanged');
    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenLastCalledWith(expect.anything(), organization, {
      plan: 'free',
      ...baseline,
      version: 2,
    });
    const snapshots = await inTenant(organization, () =>
      runner.run(({ client }) =>
        client.query(
          'select plan, seats::text, storage_bytes::text, version::text from stripe_subscription_snapshots where organization_id = $1',
          [organization],
        ),
      ),
    );
    expect(snapshots.rows).toEqual([
      { plan: 'free', seats: '5', storage_bytes: '2000000000', version: '2' },
    ]);
  });
});

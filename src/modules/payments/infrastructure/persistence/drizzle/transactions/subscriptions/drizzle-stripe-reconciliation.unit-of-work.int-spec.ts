import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { runWithOrganizationContext, type OrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DrizzleStripeBindingReader } from '../../repositories/subscriptions/drizzle-stripe-binding.repository.js';
import { DrizzleStripeReconciliationUnitOfWork } from './drizzle-stripe-reconciliation.unit-of-work.js';
import type { StripeEntitlementFence } from './stripe-entitlement-fence.transaction.js';

const project = `cadenway-billing-stripe-test-${String(process.pid)}`;
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e11';
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
      confirmedUsage: vi.fn().mockResolvedValue(null),
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
  });

  it('does not settle a change without the admission fence', async () => {
    const unit = new DrizzleStripeReconciliationUnitOfWork(runner, {
      confirmedUsage: () => Promise.resolve(null),
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
});

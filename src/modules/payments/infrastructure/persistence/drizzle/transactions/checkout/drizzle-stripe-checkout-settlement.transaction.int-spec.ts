import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { runWithOrganizationContext, type OrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DrizzleStripeReconciliationUnitOfWork } from '../subscriptions/drizzle-stripe-reconciliation.unit-of-work.js';
import type { StripeEntitlementFence } from '../subscriptions/stripe-entitlement-fence.transaction.js';
import { DrizzleCheckoutUnitOfWork } from './drizzle-checkout.unit-of-work.js';
import { DrizzleStripeCheckoutSettlement } from './drizzle-stripe-checkout-settlement.transaction.js';

const project = `cadenway-checkout-settlement-${String(process.pid)}`;
const actorId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e12';
const orgs = [
  '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e20',
  '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e21',
  '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e22',
  '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e23',
] as const;
const decision = {
  kind: 'apply' as const,
  plan: 'team' as const,
  limits: { seats: 5, storageBytes: 100_000_000_000 },
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

function context(organizationId: string): OrganizationContext {
  return { organizationId, actor: { type: 'user', id: actorId }, role: 'owner', scopes: [] };
}

describe('Stripe Checkout settlement PostgreSQL transactions', () => {
  let migrator: pg.Pool | undefined;
  let application: pg.Pool | undefined;
  let runner: TenantTransactionRunner<DatabaseSchema>;
  let checkout: DrizzleCheckoutUnitOfWork;
  let started = false;
  const inTenant = <T>(organizationId: string, work: () => Promise<T>): Promise<T> =>
    runWithOrganizationContext(context(organizationId), work);
  const fence: StripeEntitlementFence = {
    confirmedUsage: () => Promise.resolve(null),
    authorizeChange: async (scope, organizationId) => {
      await scope.client.query(
        `insert into outbox_events (id, event_name, subject, stream, organization_id, payload)
         values ($1, 'fixture', 'fixture', 'EVENTS', $2, '{}')`,
        [randomUUID(), organizationId],
      );
      return true;
    },
  };

  beforeAll(async () => {
    started = true;
    compose('up', '--pull', 'never', '--detach', '--wait', '--wait-timeout', '120', 'postgres');
    const port = compose('port', 'postgres', '5432').trim().split(':').at(-1);
    if (!port) throw new Error('PostgreSQL port was not published.');
    migrator = new pg.Pool({
      connectionString: `postgres://billing_migrator:billing_migrator@127.0.0.1:${port}/billing`,
    });
    await migrate(drizzle({ client: migrator }), { migrationsFolder: resolve('migrations') });
    application = new pg.Pool({
      connectionString: `postgres://billing_app:billing_app@127.0.0.1:${port}/billing`,
      max: 5,
    });
    runner = new TenantTransactionRunner<DatabaseSchema>(application);
    checkout = new DrizzleCheckoutUnitOfWork(runner);
  });

  afterAll(async () => {
    try {
      await application?.end();
      await migrator?.end();
    } finally {
      if (started) compose('down', '--volumes', '--remove-orphans');
    }
  });

  async function reserve(organizationId: string) {
    const claim = await inTenant(organizationId, () =>
      checkout.claim({ organizationId, actorId, idempotencyKey: 'key', plan: 'team' }),
    );
    if (claim.status !== 'claimed') throw new Error('Reservation failed.');
    const saved = await inTenant(organizationId, () =>
      checkout.saveRequest(organizationId, claim.token, {
        organizationId,
        providerKey: claim.providerKey,
        priceId: 'price_test_fixture',
        quantity: 5,
        successUrl: 'https://app.example.test/success',
        cancelUrl: 'https://app.example.test/cancel',
      }),
    );
    expect(saved).toBe(true);
    return {
      status: 'complete' as const,
      sessionId: 'cs_test_fixture',
      providerKey: claim.providerKey,
      liveMode: false,
      customerId: `cus_${organizationId}`,
      subscriptionId: `sub_${organizationId}`,
      priceId: 'price_test_fixture',
      quantity: 5,
    };
  }

  async function counts(organizationId: string) {
    return inTenant(organizationId, () =>
      runner.run(async ({ client }) => {
        const result = await client.query(
          `select
        (select count(*)::int from stripe_bindings where organization_id = $1) as bindings,
        (select count(*)::int from stripe_subscription_snapshots where organization_id = $1) as snapshots,
        (select count(*)::int from stripe_checkout_receipts where organization_id = $1) as receipts,
        (select count(*)::int from outbox_events where organization_id = $1) as outbox,
        (select count(*)::int from stripe_checkout_attempts where organization_id = $1 and resolved_at is not null) as resolved`,
          [organizationId],
        );
        return result.rows[0];
      }),
    );
  }

  it('atomically creates the initial binding, entitlement, outbox and receipt exactly once', async () => {
    const organizationId = orgs[0];
    const session = await reserve(organizationId);
    const transaction = new DrizzleStripeCheckoutSettlement(runner, fence, false);
    const settle = (eventId: string) =>
      inTenant(organizationId, () =>
        transaction.settle({ organizationId, eventId, session, decision }),
      );
    expect((await Promise.all([settle('evt_one'), settle('evt_one')])).sort()).toEqual([
      'applied',
      'duplicate',
    ]);
    expect(await settle('evt_two')).toBe('duplicate');
    expect(await counts(organizationId)).toEqual({
      bindings: 1,
      snapshots: 1,
      receipts: 2,
      outbox: 1,
      resolved: 1,
    });
  });

  it('keeps a reservation unresolved when canonical facts disagree or the entitlement is deferred', async () => {
    const organizationId = orgs[1];
    const session = await reserve(organizationId);
    const transaction = new DrizzleStripeCheckoutSettlement(
      runner,
      { ...fence, authorizeChange: () => Promise.resolve(false) },
      false,
    );
    expect(
      await inTenant(organizationId, () =>
        transaction.settle({
          organizationId,
          eventId: 'evt_wrong_key',
          session: { ...session, providerKey: `${session.providerKey}_other` },
          decision,
        }),
      ),
    ).toBe('retry');
    await expect(
      inTenant(orgs[0], () =>
        transaction.settle({ organizationId, eventId: 'evt_wrong_tenant', session, decision }),
      ),
    ).rejects.toThrow('tenant scope');
    expect(
      await inTenant(organizationId, () =>
        transaction.settle({
          organizationId,
          eventId: 'evt_bad',
          session: { ...session, quantity: 6 },
          decision,
        }),
      ),
    ).toBe('retry');
    expect(
      await inTenant(organizationId, () =>
        transaction.settle({ organizationId, eventId: 'evt_deferred', session, decision }),
      ),
    ).toBe('retry');
    expect(await counts(organizationId)).toEqual({
      bindings: 0,
      snapshots: 0,
      receipts: 0,
      outbox: 0,
      resolved: 0,
    });
  });

  it('rolls back the outbox when receipt insertion fails', async () => {
    const organizationId = orgs[2];
    const session = await reserve(organizationId);
    const transaction = new DrizzleStripeCheckoutSettlement(runner, fence, false);
    await expect(
      inTenant(organizationId, () =>
        transaction.settle({ organizationId, eventId: 'evt_one', session, decision }),
      ),
    ).rejects.toThrow();
    expect(await counts(organizationId)).toEqual({
      bindings: 0,
      snapshots: 0,
      receipts: 0,
      outbox: 0,
      resolved: 0,
    });
  });

  it('blocks unrelated subscription settlement until Checkout expires', async () => {
    const organizationId = orgs[3];
    const session = await reserve(organizationId);
    await inTenant(organizationId, () =>
      runner.run(async ({ client }) => {
        await client.query(
          'insert into stripe_bindings (organization_id, customer_id, subscription_id) values ($1, $2, $3)',
          [organizationId, 'cus_existing', 'sub_existing'],
        );
      }),
    );
    const subscriptions = new DrizzleStripeReconciliationUnitOfWork(runner, fence);
    const lock = () =>
      inTenant(organizationId, () => subscriptions.run(organizationId, (tx) => tx.lockBinding()));
    expect(await lock()).toBeNull();
    const checkoutSettlement = new DrizzleStripeCheckoutSettlement(runner, fence, false);
    expect(
      await inTenant(organizationId, () =>
        checkoutSettlement.settle({
          organizationId,
          eventId: 'evt_expired',
          session: {
            status: 'expired',
            sessionId: session.sessionId,
            providerKey: session.providerKey,
            liveMode: false,
          },
          decision: null,
        }),
      ),
    ).toBe('expired');
    expect(await lock()).toMatchObject({
      binding: { customerId: 'cus_existing', subscriptionId: 'sub_existing' },
    });
  });
});

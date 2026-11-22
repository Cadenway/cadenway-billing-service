import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { runWithOrganizationContext, type OrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StripeWebhookDelivery } from '../../../../../application/models/webhooks/stripe-webhook-delivery.model.js';
import type { StripeWebhookLease } from '../../../../../application/models/webhooks/stripe-webhook-lease.model.js';
import { DrizzleStripeWebhookInboxWrites } from './drizzle-stripe-webhook-inbox-writes.repository.js';

const project = `cadenway-webhook-inbox-test-${String(process.pid)}`;
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherOrganizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e11';
const leaseToken = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e12';
const staleToken = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e13';

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

describe('Stripe webhook inbox writes', () => {
  let migrator: pg.Pool | undefined;
  let application: pg.Pool | undefined;
  let tenant: TenantTransactionRunner<DatabaseSchema>;
  let inbox: DrizzleStripeWebhookInboxWrites;
  let started = false;
  const inTenant = <T>(organization: string, work: () => Promise<T>): Promise<T> =>
    runWithOrganizationContext(context(organization), work);

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
    tenant = new TenantTransactionRunner<DatabaseSchema>(application);
    inbox = new DrizzleStripeWebhookInboxWrites(tenant);
  });

  afterAll(async () => {
    try {
      await application?.end();
      await migrator?.end();
    } finally {
      if (started) compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('deduplicates only matching identities in the same organization', async () => {
    const delivery: StripeWebhookDelivery = {
      organizationId,
      eventId: 'evt_checkout_write',
      kind: 'checkout',
      sessionId: 'cs_test_write',
    };
    expect(await inTenant(organizationId, () => inbox.enqueue(delivery))).toBe(true);
    expect(await inTenant(organizationId, () => inbox.enqueue(delivery))).toBe(true);
    expect(
      await inTenant(organizationId, () => inbox.enqueue({ ...delivery, sessionId: 'cs_other' })),
    ).toBe(false);
    expect(
      await inTenant(otherOrganizationId, () =>
        inbox.enqueue({ ...delivery, organizationId: otherOrganizationId }),
      ),
    ).toBe(false);
    await expect(inTenant(otherOrganizationId, () => inbox.enqueue(delivery))).rejects.toThrow(
      'matching tenant scope',
    );
  });

  it('fences stale and expired leases and schedules a retry in database time', async () => {
    const delivery: StripeWebhookDelivery = {
      organizationId,
      eventId: 'evt_subscription_write',
      kind: 'subscription',
      customerId: 'cus_test_write',
      subscriptionId: 'sub_test_write',
    };
    expect(await inTenant(organizationId, () => inbox.enqueue(delivery))).toBe(true);
    const lease: StripeWebhookLease = {
      delivery,
      token: leaseToken,
      attempt: 2,
      admittedAt: new Date(),
    };
    const setLease = (token: string, interval: string): Promise<void> =>
      inTenant(organizationId, () =>
        tenant.run(async (scope) => {
          await scope.client.query(
            `update stripe_webhook_inbox
             set lease_token = $3, available_at = clock_timestamp() + $4::interval, claim_count = 2
             where organization_id = $1 and event_id = $2`,
            [organizationId, delivery.eventId, token, interval],
          );
        }),
      );
    await setLease(leaseToken, '60 seconds');
    expect(
      await inTenant(organizationId, () =>
        inbox.finish({ ...lease, token: staleToken }, 'settled'),
      ),
    ).toBe(false);
    expect(await inTenant(organizationId, () => inbox.finish(lease, 'retry'))).toBe(true);
    const retried = await inTenant(organizationId, () =>
      tenant.run(async (scope) =>
        scope.client.query(
          `select lease_token is null as released, finished_at is null as pending,
             available_at > clock_timestamp() as delayed from stripe_webhook_inbox
           where organization_id = $1 and event_id = $2`,
          [organizationId, delivery.eventId],
        ),
      ),
    );
    expect(retried.rows).toEqual([{ released: true, pending: true, delayed: true }]);
    await setLease(leaseToken, '-1 second');
    expect(await inTenant(organizationId, () => inbox.finish(lease, 'settled'))).toBe(false);
    await setLease(leaseToken, '60 seconds');
    expect(await inTenant(organizationId, () => inbox.finish(lease, 'settled'))).toBe(true);
    expect(await inTenant(organizationId, () => inbox.finish(lease, 'settled'))).toBe(false);
  });
});

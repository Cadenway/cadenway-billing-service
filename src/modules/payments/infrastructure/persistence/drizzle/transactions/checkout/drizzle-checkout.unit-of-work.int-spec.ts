import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { runWithOrganizationContext, type OrganizationContext } from '@cadenway/nest-common';
import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CheckoutProviderRequest } from '../../../../../application/models/checkout/checkout-provider-request.model.js';
import { DrizzleCheckoutUnitOfWork } from './drizzle-checkout.unit-of-work.js';

const project = `cadenway-checkout-test-${String(process.pid)}`;
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherOrganizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e11';
const actorId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e12';
const otherActorId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e13';
const upgradedOrganizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e14';
const boundaryOrganizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e15';
const dispatchKeyDigest = 'a'.repeat(64);

function providerExpiry(): number {
  return Math.floor(Date.now() / 1_000) + 2 * 60 * 60;
}

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
    actor: { type: 'user', id: actorId },
    role: 'owner',
    scopes: [],
  };
}

describe('Checkout reservation PostgreSQL transactions', () => {
  let migrator: pg.Pool | undefined;
  let application: pg.Pool | undefined;
  let runner: TenantTransactionRunner<DatabaseSchema>;
  let checkout: DrizzleCheckoutUnitOfWork;
  let started = false;
  const inTenant = <T>(organization: string, work: () => Promise<T>): Promise<T> =>
    runWithOrganizationContext(context(organization), work);
  const input = {
    organizationId,
    actorId,
    idempotencyKey: 'checkout-fixture',
    plan: 'team' as const,
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
    checkout = new DrizzleCheckoutUnitOfWork(runner, dispatchKeyDigest);
  });

  afterAll(async () => {
    try {
      await application?.end();
      await migrator?.end();
    } finally {
      if (started) compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('serializes concurrent claims, preserves provider input, fences leases and replays the response', async () => {
    const claims = await Promise.all([
      inTenant(organizationId, () => checkout.claim(input)),
      inTenant(organizationId, () => checkout.claim(input)),
    ]);
    const winner = claims.find((claim) => claim.status === 'claimed');
    expect(winner?.status).toBe('claimed');
    expect(claims.filter((claim) => claim.status === 'request-in-progress')).toHaveLength(1);
    if (winner?.status !== 'claimed') throw new Error('No lease was acquired.');
    expect(
      await inTenant(organizationId, () => checkout.findUnresolved(organizationId)),
    ).toBeNull();
    expect(
      await inTenant(organizationId, () => checkout.claim({ ...input, actorId: otherActorId })),
    ).toEqual({
      status: 'checkout-in-progress',
    });
    const expiresAt = providerExpiry();
    const request: CheckoutProviderRequest = {
      organizationId,
      providerKey: winner.providerKey,
      priceId: 'price_test_fixture',
      quantity: 5,
      successUrl: 'https://app.example.test/success',
      cancelUrl: 'https://app.example.test/cancel',
      expiresAt,
    };
    expect(
      await inTenant(organizationId, () =>
        checkout.saveRequest(organizationId, winner.token, request),
      ),
    ).toBe(true);
    const unresolved = await inTenant(organizationId, () =>
      checkout.findUnresolved(organizationId),
    );
    expect(unresolved?.providerStartedAt).toBeInstanceOf(Date);
    expect(unresolved).toMatchObject({
      organizationId,
      providerKey: winner.providerKey,
      sessionId: null,
      priceId: request.priceId,
      quantity: 5,
      expiresAt,
    });
    await inTenant(organizationId, () => checkout.release(organizationId, winner.token));
    const retried = await inTenant(organizationId, () => checkout.claim(input));
    expect(retried).toMatchObject({ status: 'claimed', providerKey: winner.providerKey, request });
    if (retried.status !== 'claimed') throw new Error('Retry did not acquire a lease.');
    expect(
      await inTenant(organizationId, () =>
        checkout.saveRequest(organizationId, retried.token, { ...request, quantity: 6 }),
      ),
    ).toBe(false);
    expect(
      await inTenant(organizationId, () =>
        checkout.saveRequest(organizationId, retried.token, {
          ...request,
          expiresAt: expiresAt + 1,
        }),
      ),
    ).toBe(false);
    expect(
      await inTenant(organizationId, () =>
        checkout.saveRequest(organizationId, retried.token, request),
      ),
    ).toBe(true);
    expect(
      await inTenant(organizationId, () =>
        checkout.complete(
          organizationId,
          winner.token,
          'https://checkout.example.test/stale',
          'cs_stale',
        ),
      ),
    ).toBe(false);
    expect(
      await inTenant(organizationId, () =>
        checkout.complete(organizationId, retried.token, 'https://checkout.example.test/one'),
      ),
    ).toBe(false);
    expect(
      await inTenant(organizationId, () =>
        checkout.complete(
          organizationId,
          retried.token,
          'https://checkout.example.test/one',
          'cs_checkout_fixture',
        ),
      ),
    ).toBe(true);
    expect(
      await inTenant(organizationId, () => checkout.findUnresolved(organizationId)),
    ).toMatchObject({
      providerKey: winner.providerKey,
      sessionId: 'cs_checkout_fixture',
    });
    expect(await inTenant(organizationId, () => checkout.claim(input))).toEqual({
      status: 'replay',
      url: 'https://checkout.example.test/one',
    });
    expect(
      await inTenant(organizationId, () =>
        checkout.claim({ ...input, idempotencyKey: 'different-checkout-key' }),
      ),
    ).toEqual({ status: 'checkout-in-progress' });
  });

  it('leases an old uncertain request for lookup while refusing provider writes and cross-tenant reads', async () => {
    const second = { ...input, organizationId: otherOrganizationId };
    const claim = await inTenant(otherOrganizationId, () => checkout.claim(second));
    if (claim.status !== 'claimed') throw new Error('Second tenant did not acquire a lease.');
    const request: CheckoutProviderRequest = {
      organizationId: otherOrganizationId,
      providerKey: claim.providerKey,
      priceId: 'price_test_other',
      quantity: 5,
      successUrl: 'https://app.example.test/success',
      cancelUrl: 'https://app.example.test/cancel',
    };
    await inTenant(otherOrganizationId, () =>
      runner.run(async ({ client }) => {
        await client.query(
          `update stripe_checkout_attempts
              set provider_started_at = now() - interval '25 hours',
                  lease_expires_at = now() - interval '1 minute',
                  price_id = $2, quantity = $3, success_url = $4, cancel_url = $5
            where organization_id = $1`,
          [
            otherOrganizationId,
            request.priceId,
            request.quantity,
            request.successUrl,
            request.cancelUrl,
          ],
        );
      }),
    );
    const retry = await inTenant(otherOrganizationId, () => checkout.claim(second));
    expect(retry).toMatchObject({ status: 'claimed', providerKey: claim.providerKey, request });
    if (retry.status !== 'claimed') throw new Error('Recovery did not acquire a lease.');
    expect(
      await inTenant(otherOrganizationId, () => checkout.findUnresolved(otherOrganizationId)),
    ).toMatchObject({
      providerKey: claim.providerKey,
      sessionId: null,
      quantity: 5,
      expiresAt: undefined,
    });
    expect(
      await inTenant(otherOrganizationId, () =>
        checkout.saveRequest(otherOrganizationId, retry.token, {
          ...request,
          expiresAt: providerExpiry(),
        }),
      ),
    ).toBe(false);
    expect(
      await inTenant(otherOrganizationId, () =>
        checkout.claim({ ...second, idempotencyKey: 'a-replacement-key' }),
      ),
    ).toEqual({ status: 'checkout-in-progress' });
    await expect(inTenant(organizationId, () => checkout.claim(second))).rejects.toThrow(
      'tenant scope',
    );
    await expect(
      inTenant(organizationId, () => checkout.findUnresolved(otherOrganizationId)),
    ).rejects.toThrow('tenant scope');
    const visible = await inTenant(organizationId, () =>
      runner.run(async ({ client }) =>
        client.query('select id from stripe_checkout_attempts where organization_id = $1', [
          otherOrganizationId,
        ]),
      ),
    );
    expect(visible.rows).toHaveLength(0);
  });

  it('rejects use within an existing transaction', async () => {
    await expect(
      inTenant(organizationId, () => runner.run(async () => checkout.claim(input))),
    ).rejects.toThrow();
  });

  it('allows recovery reads after credential rotation and keeps dispatch on the original fingerprint', async () => {
    const tenant = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e16';
    const next = { ...input, organizationId: tenant };
    await inTenant(tenant, async () => {
      const initial = await checkout.claim(next);
      if (initial.status !== 'claimed') throw new Error('No initial lease was acquired.');
      const request = {
        organizationId: tenant,
        providerKey: initial.providerKey,
        priceId: 'price_test_rotation',
        quantity: 3,
        successUrl: 'https://app.example.test/success',
        cancelUrl: 'https://app.example.test/cancel',
        expiresAt: providerExpiry(),
      };
      expect(await checkout.saveRequest(tenant, initial.token, request)).toBe(true);
      await checkout.release(tenant, initial.token);
      const rotated = new DrizzleCheckoutUnitOfWork(runner, 'b'.repeat(64));
      const retry = await rotated.claim(next);
      if (retry.status !== 'claimed') throw new Error('No recovery lease was acquired.');
      expect(retry.request).toEqual(request);
      expect(await rotated.findUnresolved(tenant)).toMatchObject({
        providerKey: initial.providerKey,
        sessionId: null,
      });
      expect(await rotated.saveRequest(tenant, retry.token, request)).toBe(false);
      expect(await checkout.saveRequest(tenant, retry.token, request)).toBe(true);
    });
  });

  it('refuses dispatch if Team is committed after the lease was claimed', async () => {
    const next = { ...input, organizationId: upgradedOrganizationId };
    const claim = await inTenant(upgradedOrganizationId, () => checkout.claim(next));
    if (claim.status !== 'claimed') throw new Error('The tenant did not acquire a lease.');
    await inTenant(upgradedOrganizationId, () =>
      runner.run(async ({ client }) => {
        await client.query(
          'insert into stripe_bindings (organization_id, customer_id, subscription_id) values ($1, $2, $3)',
          [upgradedOrganizationId, 'cus_upgraded', 'sub_upgraded'],
        );
        await client.query(
          `insert into stripe_subscription_snapshots
             (organization_id, plan, seats, storage_bytes)
           values ($1, 'team', 5, 2000000000)`,
          [upgradedOrganizationId],
        );
      }),
    );
    expect(
      await inTenant(upgradedOrganizationId, () =>
        checkout.saveRequest(upgradedOrganizationId, claim.token, {
          organizationId: upgradedOrganizationId,
          providerKey: claim.providerKey,
          priceId: 'price_test_team',
          quantity: 5,
          successUrl: 'https://app.example.test/success',
          cancelUrl: 'https://app.example.test/cancel',
          expiresAt: providerExpiry(),
        }),
      ),
    ).toBe(false);
  });

  it.each([
    ['without a snapshot', '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e30', false],
    ['with a Free snapshot', '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e31', true],
  ])('refuses a Stripe binding %s before and after reservation', async (_label, tenant, free) => {
    const next = { ...input, organizationId: tenant };
    const claim = await inTenant(tenant, () => checkout.claim(next));
    if (claim.status !== 'claimed') throw new Error('The tenant did not acquire a lease.');
    await inTenant(tenant, () =>
      runner.run(async ({ client }) => {
        await client.query(
          'insert into stripe_bindings (organization_id, customer_id, subscription_id) values ($1, $2, $3)',
          [tenant, `cus_${tenant}`, `sub_${tenant}`],
        );
        if (free) {
          await client.query(
            `insert into stripe_subscription_snapshots (organization_id, plan, seats, storage_bytes)
             values ($1, 'free', 5, 2000000000)`,
            [tenant],
          );
        }
      }),
    );
    expect(await inTenant(tenant, () => checkout.claim(next))).toEqual({ status: 'unavailable' });
    expect(
      await inTenant(tenant, () =>
        checkout.claim({ ...next, idempotencyKey: 'new-checkout-fixture' }),
      ),
    ).toEqual({ status: 'unavailable' });
    expect(
      await inTenant(tenant, () =>
        checkout.saveRequest(tenant, claim.token, {
          organizationId: tenant,
          providerKey: claim.providerKey,
          priceId: 'price_test_team',
          quantity: 5,
          successUrl: 'https://app.example.test/success',
          cancelUrl: 'https://app.example.test/cancel',
          expiresAt: providerExpiry(),
        }),
      ),
    ).toBe(false);
    const attempt = await inTenant(tenant, () =>
      runner.run(({ client }) =>
        client.query(
          'select provider_started_at, price_id, quantity from stripe_checkout_attempts where organization_id = $1',
          [tenant],
        ),
      ),
    );
    expect(attempt.rows).toEqual([{ provider_started_at: null, price_id: null, quantity: null }]);
  });

  it('checks the retention margin again immediately before dispatch', async () => {
    const next = { ...input, organizationId: boundaryOrganizationId };
    const first = await inTenant(boundaryOrganizationId, () => checkout.claim(next));
    if (first.status !== 'claimed') throw new Error('The tenant did not acquire a lease.');
    const unsignedRequest: CheckoutProviderRequest = {
      organizationId: boundaryOrganizationId,
      providerKey: first.providerKey,
      priceId: 'price_test_team',
      quantity: 5,
      successUrl: 'https://app.example.test/success',
      cancelUrl: 'https://app.example.test/cancel',
    };
    const expiry = providerExpiry();
    const request = { ...unsignedRequest, expiresAt: expiry };
    expect(
      await inTenant(boundaryOrganizationId, () =>
        checkout.saveRequest(boundaryOrganizationId, first.token, unsignedRequest),
      ),
    ).toBe(false);
    for (const expiresAt of [expiry - 90 * 60, expiry + 6 * 60]) {
      expect(
        await inTenant(boundaryOrganizationId, () =>
          checkout.saveRequest(boundaryOrganizationId, first.token, { ...request, expiresAt }),
        ),
      ).toBe(false);
    }
    expect(
      await inTenant(boundaryOrganizationId, () =>
        checkout.saveRequest(boundaryOrganizationId, first.token, request),
      ),
    ).toBe(true);
    await inTenant(boundaryOrganizationId, () =>
      checkout.release(boundaryOrganizationId, first.token),
    );
    await inTenant(boundaryOrganizationId, () =>
      runner.run(async ({ client }) => {
        await client.query(
          "update stripe_checkout_attempts set provider_started_at = clock_timestamp() - interval '23 hours 54 minutes' where organization_id = $1",
          [boundaryOrganizationId],
        );
      }),
    );
    const retry = await inTenant(boundaryOrganizationId, () => checkout.claim(next));
    if (retry.status !== 'claimed') throw new Error('The retry did not acquire a lease.');
    await inTenant(boundaryOrganizationId, () =>
      runner.run(async ({ client }) => {
        await client.query(
          "update stripe_checkout_attempts set provider_started_at = clock_timestamp() - interval '23 hours 55 minutes' where organization_id = $1",
          [boundaryOrganizationId],
        );
      }),
    );
    expect(
      await inTenant(boundaryOrganizationId, () =>
        checkout.saveRequest(boundaryOrganizationId, retry.token, request),
      ),
    ).toBe(false);
  });

  it('keeps one globally unique provider session while fencing out resolved rows', async () => {
    const firstTenant = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e32';
    const secondTenant = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e33';
    const prepare = (tenant: string): Promise<string> =>
      inTenant(tenant, async () => {
        const claim = await checkout.claim({ ...input, organizationId: tenant });
        if (claim.status !== 'claimed') throw new Error('The tenant did not acquire a lease.');
        expect(
          await checkout.saveRequest(tenant, claim.token, {
            organizationId: tenant,
            providerKey: claim.providerKey,
            priceId: 'price_test_team',
            quantity: 5,
            successUrl: 'https://app.example.test/success',
            cancelUrl: 'https://app.example.test/cancel',
            expiresAt: providerExpiry(),
          }),
        ).toBe(true);
        return claim.token;
      });
    const firstToken = await prepare(firstTenant);
    const secondToken = await prepare(secondTenant);
    const providerSessionId = 'cs_test_one_reservation';
    const url = 'https://checkout.example.test/session';
    expect(
      await inTenant(firstTenant, () =>
        checkout.complete(firstTenant, firstToken, url, providerSessionId),
      ),
    ).toBe(true);
    await inTenant(firstTenant, () =>
      runner.run(async ({ client }) => {
        await client.query(
          'update stripe_checkout_attempts set resolved_at = now() where organization_id = $1',
          [firstTenant],
        );
      }),
    );
    expect(await inTenant(firstTenant, () => checkout.findUnresolved(firstTenant))).toBeNull();
    await expect(
      inTenant(secondTenant, () =>
        checkout.complete(secondTenant, secondToken, url, providerSessionId),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    expect(await inTenant(secondTenant, () => checkout.findUnresolved(secondTenant))).toMatchObject(
      {
        sessionId: null,
      },
    );
  });
});

import { execFileSync } from 'node:child_process';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { InternalTokenSigner, loadConfig, runWithOrganizationContext } from '@cadenway/nest-common';
import type { Ed25519PrivateJwk, Ed25519PublicJwk } from '@cadenway/nest-common';
import { SystemTransactionRunner, TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createBillingApplication } from '../src/app.module.js';
import { appConfigSchema } from '../src/config/app-config.js';
import type { StripeCheckoutSessionReader } from '../src/modules/payments/application/ports/outbound/providers/checkout/stripe-checkout-session-reader.port.js';
import type { StripeSubscriptionProvider } from '../src/modules/payments/application/ports/outbound/providers/subscriptions/stripe-subscription-provider.port.js';

const retrieveSubscription = vi.hoisted(() => vi.fn<StripeSubscriptionProvider['retrieve']>());
const retrieveCheckout = vi.hoisted(() => vi.fn<StripeCheckoutSessionReader['retrieve']>());
vi.mock(
  '../src/modules/payments/infrastructure/adapters/stripe/stripe-subscription-provider.adapter.js',
  () => ({
    createStripeSubscriptionProvider: (): StripeSubscriptionProvider => ({
      retrieve: retrieveSubscription,
    }),
  }),
);
vi.mock(
  '../src/modules/payments/infrastructure/adapters/stripe/stripe-checkout-provider.adapter.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../src/modules/payments/infrastructure/adapters/stripe/stripe-checkout-provider.adapter.js')
    >()),
    createStripeCheckoutSessionReader: (): StripeCheckoutSessionReader => ({
      retrieve: retrieveCheckout,
    }),
  }),
);

const composeFile = fileURLToPath(new URL('../compose.dev.yaml', import.meta.url));
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const project = `billing-webhook-inbox-test-${String(process.pid)}`;
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherOrganizationId = '01938f6e-0000-7000-8000-000000000002';
const signatureKey = 'whsec_fixture';
const priceId = 'price_team_fixture';
const customerId = 'cus_atelier_inbox';
const subscriptionId = 'sub_atelier_inbox';
let natsPort = '0';

function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', composeFile, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0', DEV_NATS_PORT: natsPort },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function freePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('No TCP address.'));
        else resolve(String(address.port));
      });
    });
  });
}

function fixtureKeys(): {
  readonly publicJwk: Ed25519PublicJwk;
  readonly privateJwk: Ed25519PrivateJwk;
} {
  const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  if (x === undefined || d === undefined) throw new Error('Missing fixture key material.');
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x, kid: 'fixture' };
  return { publicJwk, privateJwk: { ...publicJwk, d } };
}

function signature(payload: string): string {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', signatureKey).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('durable Stripe subscription deliveries', () => {
  let app: NestExpressApplication | undefined;
  let signer: InternalTokenSigner;
  let pool: pg.Pool | undefined;
  let releaseProvider: () => void = () => undefined;
  let releaseCheckout: () => void = () => undefined;

  function service(): NestExpressApplication {
    if (app === undefined) throw new Error('The Billing fixture is not running.');
    return app;
  }

  async function submit(eventId: string, customer = customerId, subscription = subscriptionId) {
    const token = await signer.sign('billing-service', {
      actor: { type: 'system', id: 'api-gateway' },
      organizationId: null,
    });
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      type: 'customer.subscription.updated',
      livemode: false,
      data: { object: { object: 'subscription', id: subscription, customer } },
    });
    return request(service().getHttpServer())
      .post('/internal/v1/billing/webhooks/stripe')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature(payload))
      .send(payload);
  }

  async function submitCheckout(eventId: string, references: Readonly<Record<string, unknown>>) {
    const token = await signer.sign('billing-service', {
      actor: { type: 'system', id: 'api-gateway' },
      organizationId: null,
    });
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: { object: 'checkout.session', id: 'cs_atelier_fixture', ...references } },
    });
    return request(service().getHttpServer())
      .post('/internal/v1/billing/webhooks/stripe')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature(payload))
      .send(payload);
  }

  beforeAll(async () => {
    natsPort = await freePort();
    compose(
      'up',
      '--detach',
      '--pull',
      'never',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
      'nats',
      'nats-streams',
    );
    const postgresPort = compose('port', 'postgres', '5432').trim().split(':').at(-1);
    if (postgresPort === undefined) throw new Error('PostgreSQL port missing.');
    pool = new pg.Pool({
      connectionString: `postgres://billing_migrator:billing_migrator@127.0.0.1:${postgresPort}/billing`,
    });
    await migrate(drizzle({ client: pool }), { migrationsFolder });

    const gateway = fixtureKeys();
    vi.stubEnv('PORT', '3012');
    vi.stubEnv('LOG_PRETTY', 'false');
    vi.stubEnv(
      'DATABASE_URL',
      `postgres://billing_app:billing_app@127.0.0.1:${postgresPort}/billing`,
    );
    vi.stubEnv('NATS_URL', `nats://127.0.0.1:${natsPort}`);
    vi.stubEnv('NATS_USER', 'billing');
    vi.stubEnv('NATS_PASSWORD', 'billing');
    vi.stubEnv('INTERNAL_TOKEN_AUDIENCE', 'billing-service');
    vi.stubEnv(
      'INTERNAL_TOKEN_TRUSTED_ISSUERS',
      JSON.stringify({ 'api-gateway': [gateway.publicJwk] }),
    );
    vi.stubEnv('BILLING_STRIPE_WEBHOOK_MODE', 'test');
    vi.stubEnv('BILLING_STRIPE_WEBHOOK_SECRETS', JSON.stringify([signatureKey]));
    vi.stubEnv('BILLING_STRIPE_SETTLEMENT_ENABLED', 'true');
    vi.stubEnv('BILLING_STRIPE_WEBHOOK_INBOX_ENABLED', 'true');
    vi.stubEnv('BILLING_STRIPE_API_KEY', 'rk_test_local_fixture');
    vi.stubEnv('BILLING_STRIPE_TEAM_PRICE_IDS', JSON.stringify([priceId]));

    app = await createBillingApplication(loadConfig(appConfigSchema), undefined, {
      write: () => undefined,
    });
    await app.listen(0, '127.0.0.1');
    signer = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: gateway.privateJwk,
    });

    const system = app.get(SystemTransactionRunner);
    await system.run(async ({ client }) => {
      await client.query(
        'insert into stripe_bindings (organization_id, customer_id, subscription_id) values ($1, $2, $3)',
        [organizationId, customerId, subscriptionId],
      );
    });
  });

  afterAll(async () => {
    releaseProvider();
    releaseCheckout();
    try {
      await app?.close();
      await pool?.end();
    } finally {
      vi.unstubAllEnvs();
      compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('acknowledges one committed delivery while Stripe is unavailable and settles it once', async () => {
    const eventId = 'evt_atelier_inbox';
    const blocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    retrieveSubscription.mockImplementation(async () => {
      await blocked;
      return {
        customerId,
        subscriptionId,
        liveMode: false,
        status: 'active',
        scheduledCancellation: false,
        collectionPaused: false,
        hasMoreItems: false,
        items: [{ priceId, quantity: 8 }],
      };
    });

    const first = await submit(eventId);
    expect(first.status).toBe(204);
    expect(first.headers['cache-control']).toBe('private, no-store');
    const tenant = service().get(TenantTransactionRunner);
    const read = (tenantId: string) =>
      runWithOrganizationContext(
        {
          organizationId: tenantId,
          actor: { type: 'system', id: 'billing-service' },
          role: null,
          scopes: [],
        },
        () =>
          tenant.run(async ({ client }) => {
            const inbox = await client.query(
              'select event_id, organization_id, finished_at from stripe_webhook_inbox where event_id = $1',
              [eventId],
            );
            const receipts = await client.query(
              'select event_id from stripe_reconciliation_receipts where event_id = $1',
              [eventId],
            );
            const outbox = await client.query(
              "select event_name from outbox_events where organization_id = $1 and event_name = 'subscription.changed.v1'",
              [tenantId],
            );
            return {
              inbox: inbox.rows as readonly {
                event_id: string;
                organization_id: string;
                finished_at: Date | null;
              }[],
              receipts: receipts.rows,
              outbox: outbox.rows,
            };
          }),
      );
    expect((await read(organizationId)).inbox).toMatchObject([
      { event_id: eventId, organization_id: organizationId, finished_at: null },
    ]);
    expect((await read(otherOrganizationId)).inbox).toEqual([]);
    expect((await submit(eventId)).status).toBe(204);
    expect((await read(organizationId)).receipts).toEqual([]);
    await vi.waitFor(
      () => {
        expect(retrieveSubscription).toHaveBeenCalled();
      },
      { timeout: 20_000 },
    );
    releaseProvider();

    await vi.waitFor(
      async () => {
        const state = await read(organizationId);
        expect(state.inbox).toHaveLength(1);
        expect(state.inbox[0]?.event_id).toBe(eventId);
        expect(state.inbox[0]?.finished_at).toBeInstanceOf(Date);
        expect(state.receipts).toEqual([{ event_id: eventId }]);
        expect(state.outbox).toHaveLength(1);
      },
      { timeout: 30_000 },
    );
    expect((await submit(eventId)).status).toBe(204);
    expect((await read(organizationId)).outbox).toHaveLength(1);
  });

  it('keeps an unbound provider pair retryable', async () => {
    const response = await submit('evt_unbound_inbox', 'cus_missing', 'sub_missing');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'billing.unavailable' });
  });

  it('records a Checkout delivery only with a matching reserved reference', async () => {
    const tenant = service().get(TenantTransactionRunner);
    await runWithOrganizationContext(
      {
        organizationId: otherOrganizationId,
        actor: { type: 'system', id: 'billing-service' },
        role: null,
        scopes: [],
      },
      () =>
        tenant.run(async ({ client }) => {
          await client.query(
            `insert into stripe_checkout_attempts (organization_id, actor_id, key_digest, plan, provider_key)
           values ($1, $2, $3, 'team', $4)`,
            [otherOrganizationId, organizationId, 'a'.repeat(64), 'checkout_atelier'],
          );
        }),
    );
    const blocked = new Promise<void>((resolve) => {
      releaseCheckout = resolve;
    });
    retrieveCheckout.mockImplementation(async () => {
      await blocked;
      return { status: 'pending' };
    });
    const accepted = await submitCheckout('evt_checkout_inbox', {
      client_reference_id: 'checkout_atelier',
      metadata: { cadenway_checkout_key: 'checkout_atelier' },
    });
    expect(accepted.status).toBe(204);
    const rows = await runWithOrganizationContext(
      {
        organizationId: otherOrganizationId,
        actor: { type: 'system', id: 'billing-service' },
        role: null,
        scopes: [],
      },
      () =>
        tenant.run(async ({ client }) =>
          client.query(
            'select event_id, kind, session_id from stripe_webhook_inbox where event_id = $1',
            ['evt_checkout_inbox'],
          ),
        ),
    );
    expect(rows.rows).toEqual([
      { event_id: 'evt_checkout_inbox', kind: 'checkout', session_id: 'cs_atelier_fixture' },
    ]);
    releaseCheckout();
    const mismatch = await submitCheckout('evt_checkout_mismatch', {
      client_reference_id: 'checkout_atelier',
      metadata: { cadenway_checkout_key: 'another_checkout' },
    });
    expect(mismatch.status).toBe(503);
    expect(retrieveCheckout).toHaveBeenCalledWith('cs_atelier_fixture');
  });

  it('returns a retryable response when the verified delivery cannot be stored', async () => {
    if (pool === undefined) throw new Error('The migrator pool is not running.');
    await pool.query('revoke insert on stripe_webhook_inbox from billing_app');
    try {
      const response = await submit('evt_storage_unavailable');
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'billing.unavailable' });
    } finally {
      await pool.query('grant insert on stripe_webhook_inbox to billing_app');
    }
  });

  it('recovers an expired lease after settlement when new inbox admission is disabled', async () => {
    const eventId = 'evt_atelier_inbox';
    await service().close();
    if (pool === undefined) throw new Error('The migrator pool is not running.');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.organization_id', $1, true)", [organizationId]);
      const reset = await client.query(
        `update stripe_webhook_inbox
         set finished_at = null, lease_token = '01938f6e-0000-7000-8000-000000000003',
             available_at = now() - interval '1 second'
         where event_id = $1`,
        [eventId],
      );
      expect(reset.rowCount).toBe(1);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    retrieveSubscription.mockClear();
    vi.stubEnv('BILLING_STRIPE_WEBHOOK_INBOX_ENABLED', 'false');
    app = await createBillingApplication(loadConfig(appConfigSchema), undefined, {
      write: () => undefined,
    });
    await app.listen(0, '127.0.0.1');
    const tenant = service().get(TenantTransactionRunner);
    const read = () =>
      runWithOrganizationContext(
        {
          organizationId,
          actor: { type: 'system', id: 'billing-service' },
          role: null,
          scopes: [],
        },
        () =>
          tenant.run(async ({ client: scope }) => {
            const inbox = await scope.query(
              'select finished_at from stripe_webhook_inbox where event_id = $1',
              [eventId],
            );
            const receipts = await scope.query(
              'select event_id from stripe_reconciliation_receipts where event_id = $1',
              [eventId],
            );
            const outbox = await scope.query(
              "select event_name from outbox_events where organization_id = $1 and event_name = 'subscription.changed.v1'",
              [organizationId],
            );
            return {
              inbox: inbox.rows as readonly { finished_at: Date | null }[],
              receipts: receipts.rows,
              outbox: outbox.rows,
            };
          }),
      );
    await vi.waitFor(
      async () => {
        const state = await read();
        expect(state.inbox).toHaveLength(1);
        expect(state.inbox[0]?.finished_at).toBeInstanceOf(Date);
        expect(state.receipts).toEqual([{ event_id: eventId }]);
        expect(state.outbox).toHaveLength(1);
      },
      { timeout: 30_000 },
    );
    expect(retrieveSubscription).not.toHaveBeenCalled();
  });
});

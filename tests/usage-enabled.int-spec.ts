import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { GetBillingSubscriptionInternalResponse } from '@cadenway/contracts/validators/internal/billing-service';
import { QUOTA_THRESHOLD_REACHED_V1 } from '@cadenway/contracts/events/billing-service';
import {
  createApplication,
  InternalTokenSigner,
  InternalTokenVerifier,
  loadConfig,
} from '@cadenway/nest-common';
import { SystemTransactionRunner } from '@cadenway/nest-common/database';
import type { DatabaseSchema } from '@cadenway/nest-common/database';
import type { Ed25519PrivateJwk, Ed25519PublicJwk } from '@cadenway/nest-common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { appConfigSchema } from '../src/config/app-config.js';
import { configureBillingSubscriptionCache } from '../src/infrastructure/http/billing-subscription-cache.js';

const composeFile = fileURLToPath(new URL('../compose.dev.yaml', import.meta.url));
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const project = `cadenway-billing-enabled-test-${String(process.pid)}`;
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const memberId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';
const actorId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c26';
let releaseMembership: () => void = () => undefined;
const membershipReleased = new Promise<void>((resolve) => {
  releaseMembership = resolve;
});

function compose(...args: readonly string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--project-name', project, '--file', composeFile, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, DEV_POSTGRES_PORT: '0', DEV_NATS_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function port(service: string, containerPort: string): string {
  const result = compose('port', service, containerPort).trim().split(':').at(-1);
  if (!result) throw new Error('A dependency port is missing.');
  return result;
}

function keyPair(): {
  readonly publicJwk: Ed25519PublicJwk;
  readonly privateJwk: Ed25519PrivateJwk;
} {
  const { x, d } = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  if (!x || !d) throw new Error('Cannot create synthetic test keys.');
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x, kid: 'billing-fixture' };
  return { publicJwk, privateJwk: { ...publicJwk, d } };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture did not listen.');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: Server | undefined): Promise<void> {
  if (server?.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
}

/** Serves the published source shapes only after verifying Billing's signed service identity. */
async function authority(
  audience: 'organization-service' | 'storage-service',
  publicJwk: Ed25519PublicJwk,
  received: string[],
): Promise<Server> {
  const verifier = await InternalTokenVerifier.create({
    audience,
    trustedIssuers: { 'billing-service': [publicJwk] },
  });
  return createServer((incoming, response) => {
    void (async () => {
      const path = new URL(incoming.url ?? '/', 'http://fixture').pathname;
      const authorization = incoming.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) throw new Error('Missing signed token.');
      const claims = await verifier.verify(authorization.slice(7));
      const tenant = path === '/internal/v1/billing-organizations' ? null : organizationId;
      expect(claims).toMatchObject({
        issuer: 'billing-service',
        audience,
        actor: { type: 'system', id: 'billing-service' },
        organizationId: tenant,
      });
      const pages: Readonly<Record<string, unknown>> =
        audience === 'organization-service'
          ? {
              '/internal/v1/billing-organizations': { items: [organizationId], nextCursor: null },
              '/internal/v1/billing-memberships': {
                items: [
                  { memberId, state: 'active', role: 'member', version: 1 },
                  ...[
                    '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c30',
                    '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c31',
                    '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c32',
                  ].map((id) => ({ memberId: id, state: 'active', role: 'member', version: 1 })),
                ],
                nextCursor: null,
              },
            }
          : {
              '/internal/v1/billing-attachment-usage': { items: [], nextCursor: null },
            };
      if (!Object.hasOwn(pages, path)) throw new Error('Unexpected source route.');
      received.push(`${audience}:${path}`);
      if (path === '/internal/v1/billing-memberships') await membershipReleased;
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      });
      response.end(JSON.stringify(pages[path]));
    })().catch(() => {
      response.writeHead(403);
      response.end();
    });
  });
}

function publish(subject: string, payload: unknown): void {
  compose('exec', '-T', 'nats-streams', 'nats', 'pub', subject, JSON.stringify(payload));
}

describe('enabled Billing projection', () => {
  const billing = keyPair();
  const gateway = keyPair();
  const received: string[] = [];
  let organization: Server | undefined;
  let storage: Server | undefined;
  let app: NestExpressApplication | undefined;
  let database: pg.Pool | undefined;
  let started = false;

  beforeAll(async () => {
    started = true;
    compose(
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      '120',
      'postgres',
      'nats',
      'nats-streams',
    );
    const postgresPort = port('postgres', '5432');
    database = new pg.Pool({
      connectionString: `postgres://billing_migrator:billing_migrator@127.0.0.1:${postgresPort}/billing`,
    });
    await migrate(drizzle({ client: database }), { migrationsFolder });

    // The roster snapshot below includes this committed member. Delivery must still be recorded
    // when the event was retained before the application's durable was registered.
    publish('evt.member.joined.v1', {
      id: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c29',
      organizationId,
      occurredAt: new Date().toISOString(),
      actor: { type: 'user', id: actorId },
      version: 1,
      memberId: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c30',
      userId: actorId,
      role: 'member',
      invitationId: null,
    });

    organization = await authority('organization-service', billing.publicJwk, received);
    storage = await authority('storage-service', billing.publicJwk, received);
    const organizationUrl = await listen(organization);
    const storageUrl = await listen(storage);

    vi.stubEnv('PORT', '3012');
    vi.stubEnv('LOG_PRETTY', 'false');
    vi.stubEnv(
      'DATABASE_URL',
      `postgres://billing_app:billing_app@127.0.0.1:${postgresPort}/billing`,
    );
    vi.stubEnv('NATS_URL', `nats://127.0.0.1:${port('nats', '4222')}`);
    vi.stubEnv('NATS_USER', 'billing');
    vi.stubEnv('NATS_PASSWORD', 'billing');
    vi.stubEnv('INTERNAL_TOKEN_AUDIENCE', 'billing-service');
    vi.stubEnv(
      'INTERNAL_TOKEN_TRUSTED_ISSUERS',
      JSON.stringify({ 'api-gateway': [gateway.publicJwk] }),
    );
    vi.stubEnv('INTERNAL_TOKEN_PRIVATE_JWK', JSON.stringify(billing.privateJwk));
    vi.stubEnv('BILLING_USAGE_ENABLED', 'true');
    vi.stubEnv('ORGANIZATION_SERVICE_URL', organizationUrl);
    vi.stubEnv('STORAGE_SERVICE_URL', storageUrl);
    const config = loadConfig(appConfigSchema);
    app = await createApplication(AppModule, {
      service: 'billing-service',
      config,
      internalToken: {
        verifier: {
          audience: config.INTERNAL_TOKEN_AUDIENCE,
          trustedIssuers: config.INTERNAL_TOKEN_TRUSTED_ISSUERS,
        },
      },
      logDestination: { write: (): void => undefined },
    });
    configureBillingSubscriptionCache(app);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    try {
      releaseMembership();
      await app?.close();
      await close(organization);
      await close(storage);
      await database?.end();
    } finally {
      vi.unstubAllEnvs();
      if (started) compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('reconciles a concurrent event, deduplicates replay and refuses usage after a terminal advisory', async () => {
    if (app === undefined || database === undefined) throw new Error('Billing did not start.');
    const signer = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: gateway.privateJwk,
    });
    const token = await signer.sign('billing-service', {
      actor: { type: 'user', id: actorId },
      organizationId,
    });
    const api = request(app.getHttpServer());
    const subscription = () =>
      api.get('/internal/v1/billing/subscription').set('Authorization', `Bearer ${token}`);

    const system = app.get<SystemTransactionRunner<DatabaseSchema>>(SystemTransactionRunner);
    await expect
      .poll(() => received.includes('organization-service:/internal/v1/billing-memberships'), {
        timeout: 30_000,
        interval: 250,
      })
      .toBe(true);
    publish('evt.member.joined.v1', {
      id: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c27',
      organizationId,
      occurredAt: new Date().toISOString(),
      actor: { type: 'user', id: actorId },
      version: 2,
      memberId,
      userId: actorId,
      role: 'guest',
      invitationId: null,
    });
    await expect
      .poll(
        () =>
          system.run(
            async (scope) => {
              const result = await scope.client.query(
                'select count(*)::int as count from processed_events where event_id = $1',
                ['01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c27'],
              );
              return (result.rows[0] as { readonly count: number } | undefined)?.count;
            },
            { readOnly: true },
          ),
        { timeout: 5_000, interval: 100 },
      )
      .toBe(1);
    await expect
      .poll(
        () =>
          system.run(
            async (scope) => {
              const result = await scope.client.query(
                'select count(*)::int as count from processed_events where event_id = $1',
                ['01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c29'],
              );
              return (result.rows[0] as { readonly count: number } | undefined)?.count;
            },
            { readOnly: true },
          ),
        { timeout: 5_000, interval: 100 },
      )
      .toBe(1);
    releaseMembership();
    await expect
      .poll(async () => (await subscription()).status, { timeout: 45_000, interval: 500 })
      .toBe(200);
    const initial = await subscription();
    expect(GetBillingSubscriptionInternalResponse.parse(initial.body)).toMatchObject({
      plan: 'free',
      seats: { used: 3, limit: 5 },
      guestCount: 1,
      storage: { attachmentBytesUsed: 0, limitBytes: 2_000_000_000 },
    });
    expect(received).toEqual(
      expect.arrayContaining([
        'organization-service:/internal/v1/billing-organizations',
        'organization-service:/internal/v1/billing-memberships',
        'storage-service:/internal/v1/billing-attachment-usage',
      ]),
    );

    const joined = {
      id: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c28',
      organizationId,
      occurredAt: new Date().toISOString(),
      actor: { type: 'user', id: actorId },
      version: 1,
      memberId: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c33',
      userId: actorId,
      role: 'member',
      invitationId: null,
    };
    publish('evt.member.joined.v1', joined);
    publish('evt.member.joined.v1', joined);
    await expect
      .poll(
        async () => {
          const response = await subscription();
          return GetBillingSubscriptionInternalResponse.parse(response.body).seats.used;
        },
        { timeout: 15_000, interval: 250 },
      )
      .toBe(4);
    await expect
      .poll(
        () =>
          system.run(
            async (scope) => {
              const result = await scope.client.query(
                'select count(*)::int as count from outbox_events where event_name = $1',
                [QUOTA_THRESHOLD_REACHED_V1],
              );
              return (result.rows[0] as { readonly count: number } | undefined)?.count;
            },
            { readOnly: true },
          ),
        { timeout: 10_000, interval: 250 },
      )
      .toBe(1);

    publish('evt.member.removed.v1', {
      ...joined,
      id: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c34',
      version: 2,
    });
    await expect
      .poll(
        async () => {
          const response = await subscription();
          return GetBillingSubscriptionInternalResponse.parse(response.body).seats.used;
        },
        { timeout: 15_000, interval: 250 },
      )
      .toBe(3);

    publish(
      '$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.EVENTS.billing-service__record-member-joined',
      { type: 'io.nats.jetstream.advisory.v1.terminated', id: 'fixture' },
    );
    const latch: unknown = JSON.parse(
      compose(
        'exec',
        '-T',
        'nats-streams',
        'nats',
        'stream',
        'info',
        'BILLING_REBUILD_ADVISORIES',
        '--json',
      ),
    );
    expect(latch).toMatchObject({ state: { messages: 1 } });
    const unavailable = await subscription();
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: 'billing.unavailable' });
    expect(unavailable.headers['cache-control']).toBe('private, no-store');

    const afterAdvisoryId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c35';
    publish('evt.member.joined.v1', {
      ...joined,
      id: afterAdvisoryId,
      memberId: '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c36',
    });
    await expect
      .poll(
        () =>
          system.run(
            async (scope) => {
              const result = await scope.client.query(
                'select count(*)::int as count from processed_events where event_id = $1',
                [afterAdvisoryId],
              );
              return (result.rows[0] as { readonly count: number } | undefined)?.count;
            },
            { readOnly: true },
          ),
        { timeout: 10_000, interval: 100 },
      )
      .toBe(1);

    await expect
      .poll(
        () =>
          system.run(
            async (scope) => {
              const result = await scope.client.query(
                'select active_generation_id from usage_organizations where organization_id = $1',
                [organizationId],
              );
              return (
                result.rows[0] as { readonly active_generation_id: string | null } | undefined
              )?.active_generation_id;
            },
            { readOnly: true },
          ),
        { timeout: 15_000, interval: 250 },
      )
      .toBeNull();
    const outbox = await system.run(
      (scope) =>
        scope.client.query(
          'select count(*)::int as count from outbox_events where event_name = $1',
          [QUOTA_THRESHOLD_REACHED_V1],
        ),
      { readOnly: true },
    );
    expect(outbox.rows).toEqual([{ count: 1 }]);
  });
});

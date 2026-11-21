import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { OrganizationContext } from '@cadenway/nest-common';
import { SystemTransactionRunner, TenantTransactionRunner } from '@cadenway/nest-common/database';
import type { DatabaseSchema } from '@cadenway/nest-common/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { UsageRebuildBrokerProgress } from '../src/modules/usage/application/models/rebuild/usage-rebuild-broker-progress.model.js';
import type { UsageBrokerProof } from '../src/modules/usage/application/ports/outbound/messaging/rebuild/usage-broker-proof.port.js';
import { RecordUsageObservation } from '../src/modules/usage/application/use-cases/commands/observations/record-usage-observation/record-usage-observation.use-case.js';
import { ApplyUsageRebuildPage } from '../src/modules/usage/application/use-cases/commands/rebuild/apply-usage-rebuild-page/apply-usage-rebuild-page.use-case.js';
import { InvalidateActiveUsage } from '../src/modules/usage/application/use-cases/commands/rebuild/invalidate-active-usage/invalidate-active-usage.use-case.js';
import { PromoteUsageRebuild } from '../src/modules/usage/application/use-cases/commands/rebuild/promote-usage-rebuild/promote-usage-rebuild.use-case.js';
import { StartUsageRebuild } from '../src/modules/usage/application/use-cases/commands/rebuild/start-usage-rebuild/start-usage-rebuild.use-case.js';
import { DrizzleUsageRebuildRegistryReader } from '../src/modules/usage/infrastructure/persistence/drizzle/repositories/rebuild/drizzle-usage-rebuild-registry.repository.js';
import { DrizzleUsageRebuildStateReader } from '../src/modules/usage/infrastructure/persistence/drizzle/repositories/rebuild/drizzle-usage-rebuild-state.repository.js';
import { DrizzleUsageObservationUnitOfWork } from '../src/modules/usage/infrastructure/persistence/drizzle/transactions/observations/drizzle-usage-observation.unit-of-work.js';
import { DrizzleUsageRebuildUnitOfWork } from '../src/modules/usage/infrastructure/persistence/drizzle/transactions/rebuild/drizzle-usage-rebuild.unit-of-work.js';

const composeFile: string = fileURLToPath(new URL('../compose.dev.yaml', import.meta.url));
const migrationsFolder: string = fileURLToPath(new URL('../migrations', import.meta.url));
const project = `cadenway-billing-rebuild-test-${String(process.pid)}`;
const organizationId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e10';
const otherId = '01938f6e-6d1a-7c3e-9a51-2f0c4b8d7e11';
const memberId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c24';
const fileId = '01938f6e-8a42-7d5b-b2c9-5e1f3a6d9c25';

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

function context(organization: string): OrganizationContext {
  return {
    organizationId: organization,
    actor: { type: 'system', id: 'billing-service' },
    role: null,
    scopes: [],
  };
}

const progress: UsageRebuildBrokerProgress = {
  stream: 'EVENTS',
  createdAt: '2026-11-20T10:00:00.000Z',
  firstSequence: 1,
  lastSequence: 10,
  retainedGapCount: 0,
  consumers: [
    {
      handler: 'record-member-joined',
      createdAt: '2026-11-20T10:00:00.000Z',
      deliveredSequence: 10,
      ackFloorSequence: 10,
      pending: 0,
      ackPending: 0,
    },
  ],
};
const proof: UsageBrokerProof = { validStart: () => true, assess: () => 'covered' };

describe('usage rebuild PostgreSQL transactions', () => {
  let migrator: pg.Pool | undefined;
  let application: pg.Pool | undefined;
  let runner: TenantTransactionRunner<DatabaseSchema>;
  let system: SystemTransactionRunner<DatabaseSchema>;
  let uow: DrizzleUsageRebuildUnitOfWork;
  let state: DrizzleUsageRebuildStateReader;
  let started = false;

  beforeAll(async () => {
    started = true;
    compose('up', '--detach', '--wait', '--wait-timeout', '120', 'postgres');
    const port = compose('port', 'postgres', '5432').trim().split(':').at(-1);
    if (port === undefined) throw new Error('PostgreSQL port was not published.');
    migrator = new pg.Pool({
      connectionString: `postgres://billing_migrator:billing_migrator@127.0.0.1:${port}/billing`,
    });
    await migrate(drizzle({ client: migrator }), { migrationsFolder });
    application = new pg.Pool({
      connectionString: `postgres://billing_app:billing_app@127.0.0.1:${port}/billing`,
      max: 5,
    });
    runner = new TenantTransactionRunner<DatabaseSchema>(application);
    system = new SystemTransactionRunner<DatabaseSchema>(application);
    uow = new DrizzleUsageRebuildUnitOfWork(runner);
    state = new DrizzleUsageRebuildStateReader(runner);
  });

  afterAll(async () => {
    try {
      await application?.end();
      await migrator?.end();
    } finally {
      if (started) compose('down', '--volumes', '--remove-orphans');
    }
  });

  it('commits bounded pages once, rolls back interrupted work and promotes after a fresh read', async () => {
    const start = new StartUsageRebuild(uow, proof);
    const apply = new ApplyUsageRebuildPage(uow);
    const promote = new PromoteUsageRebuild(uow, proof);
    const invalidate = new InvalidateActiveUsage(uow);
    const inTenant = <T>(work: () => Promise<T>): Promise<T> =>
      runWithOrganizationContext(context(organizationId), work);

    const [first, second] = await Promise.all([
      inTenant(() =>
        start.execute({ organizationId, brokerAtStart: progress, advisoriesClear: true }),
      ),
      inTenant(() =>
        start.execute({ organizationId, brokerAtStart: progress, advisoriesClear: true }),
      ),
    ]);
    expect(first.generationId).toBe(second.generationId);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    const generationId = first.generationId;

    await expect(
      inTenant(() =>
        uow.run(organizationId, async (tx) => {
          await tx.lockOrganization();
          await tx.saveObservation(generationId, {
            source: 'membership',
            sourceId: memberId,
            observation: { state: 'present', version: 1, value: 'member' },
          });
          throw new Error('simulate interrupted page');
        }),
      ),
    ).rejects.toThrow('simulate interrupted page');
    const rolledBack = await inTenant(() =>
      uow.run(organizationId, async (tx) => {
        await tx.lockOrganization();
        return tx.loadObservation(generationId, 'membership', memberId);
      }),
    );
    expect(rolledBack).toBeNull();

    const page = {
      organizationId,
      generationId,
      source: 'membership' as const,
      expectedCursor: null,
      nextCursor: 'next',
      items: [
        {
          source: 'membership' as const,
          sourceId: memberId,
          observation: { state: 'present' as const, version: 1, value: 'guest' as const },
        },
      ],
    };
    const pageResults = await Promise.all([
      inTenant(() => apply.execute(page)),
      inTenant(() => apply.execute(page)),
    ]);
    expect(pageResults.sort()).toEqual(['applied', 'stale']);
    const firstItem = page.items[0];
    if (firstItem === undefined) throw new Error('The source page fixture is empty.');
    await expect(
      inTenant(() =>
        apply.execute({ ...page, items: Array.from({ length: 101 }, () => firstItem) }),
      ),
    ).rejects.toThrow();

    const record = new RecordUsageObservation(
      new DrizzleUsageObservationUnitOfWork(runner, { seats: 5, storageBytes: 2_000_000_000 }, () =>
        Promise.resolve(),
      ),
    );
    const roleChange = () =>
      record.execute({
        organizationId,
        observation: {
          source: 'membership',
          sourceId: memberId,
          observation: { state: 'present', version: 2, value: 'member' },
        },
      });
    const finishMembers = () =>
      apply.execute({ ...page, expectedCursor: 'next', nextCursor: null, items: [] });
    expect((await Promise.all([inTenant(roleChange), inTenant(finishMembers)])).sort()).toEqual([
      'applied',
      'recorded',
    ]);
    await expect(
      inTenant(() =>
        apply.execute({
          organizationId,
          generationId,
          source: 'attachment',
          expectedCursor: null,
          nextCursor: null,
          items: [
            {
              source: 'attachment',
              sourceId: fileId,
              observation: { state: 'present', version: 1, value: 256 },
            },
          ],
        }),
      ),
    ).resolves.toBe('applied');

    const current = await inTenant(() => state.read(organizationId));
    expect(current.candidate).toMatchObject({
      id: generationId,
      totals: { seats: 1, guests: 0, storageBytes: 256 },
      membership: { complete: true },
      attachment: { complete: true },
      brokerAtStart: progress,
    });
    if (current.candidate === null) throw new Error('Candidate disappeared.');
    const expectedCandidateVersion = current.candidate.version;
    await expect(
      inTenant(() =>
        promote.execute({
          organizationId,
          generationId,
          expectedCandidateVersion: expectedCandidateVersion - 1,
          brokerAtPromotion: progress,
          advisoriesClear: true,
        }),
      ),
    ).resolves.toBe('stale');
    await expect(
      inTenant(() =>
        promote.execute({
          organizationId,
          generationId,
          expectedCandidateVersion,
          brokerAtPromotion: progress,
          advisoriesClear: true,
        }),
      ),
    ).resolves.toBe('promoted');
    const active = await inTenant(() => state.read(organizationId));
    expect(active.candidate).toBeNull();
    expect(active.active).toMatchObject({ id: generationId, brokerAtPromotion: progress });
    if (active.active === null) throw new Error('Promotion did not persist.');
    const activeVersion = active.active.version;
    const advanced = { ...progress, firstSequence: 2, lastSequence: 11 };
    const checkpoint = (version: number): Promise<boolean> =>
      inTenant(() =>
        uow.run(organizationId, async (tx) => {
          await tx.lockOrganization();
          return tx.checkpointActive(generationId, version, advanced);
        }),
      );
    await expect(checkpoint(activeVersion - 1)).resolves.toBe(false);
    await expect(checkpoint(activeVersion)).resolves.toBe(true);
    await expect(checkpoint(activeVersion)).resolves.toBe(false);
    const refreshed = await inTenant(() => state.read(organizationId));
    expect(refreshed.active).toMatchObject({
      id: generationId,
      version: activeVersion + 1,
      brokerAtPromotion: advanced,
    });
    const persisted = await inTenant(() =>
      runner.run((tx) =>
        tx.client.query(
          'select stream_checkpoint from usage_generations where organization_id = $1 and id = $2',
          [organizationId, generationId],
        ),
      ),
    );
    expect(persisted.rows).toMatchObject([
      { stream_checkpoint: { start: progress, promotion: progress, verified: advanced } },
    ]);
    await expect(
      inTenant(() =>
        invalidate.execute({
          organizationId,
          generationId,
          expectedVersion: activeVersion - 1,
        }),
      ),
    ).resolves.toBe('stale');
    await expect(
      inTenant(() =>
        invalidate.execute({
          organizationId,
          generationId,
          expectedVersion: activeVersion + 1,
        }),
      ),
    ).resolves.toBe('invalidated');
    expect((await inTenant(() => state.read(organizationId))).active).toBeNull();
    await expect(
      runWithOrganizationContext(context(otherId), () => state.read(organizationId)),
    ).rejects.toThrow();
  });

  it('pages the system registry in UUID order with a bounded lookahead', async () => {
    await system.run(async (tx) => {
      await tx.client.query(`insert into usage_organizations (organization_id)
        select ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid
        from generate_series(1, 52) as n`);
    });
    const registry = new DrizzleUsageRebuildRegistryReader(system);
    const first = await registry.list(null, 50);
    expect(first.items).toHaveLength(50);
    expect(first.nextId).toBe(first.items.at(-1));
    const second = await registry.list(first.nextId, 50);
    expect(second.items.length).toBeGreaterThanOrEqual(2);
    expect(new Set([...first.items, ...second.items]).size).toBe(
      first.items.length + second.items.length,
    );
    const lastFirstId = first.items.at(-1);
    const firstSecondId = second.items[0];
    if (lastFirstId === undefined || firstSecondId === undefined)
      throw new Error('Registry page missing.');
    expect(firstSecondId > lastFirstId).toBe(true);
    await expect(registry.list(null, 51)).rejects.toThrow();
  });
});

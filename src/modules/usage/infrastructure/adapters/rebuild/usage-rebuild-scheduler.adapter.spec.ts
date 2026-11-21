import { getOrganizationContext } from '@cadenway/nest-common';
import { HttpAdapterHost } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsageSnapshotPage } from '../../../application/models/usage-snapshot/usage-snapshot-page.model.js';
import type { UsageSnapshotSource } from '../../../application/ports/outbound/http/snapshot/usage-snapshot-source.port.js';
import type { UsageRebuildRegistryReader } from '../../../application/ports/outbound/persistence/rebuild/usage-rebuild-registry-reader.port.js';
import type { AdvanceUsageRebuild } from '../../../application/services/rebuild/advance-usage-rebuild.service.js';
import { UsageSnapshotReadError } from '../../../domain/errors/usage-snapshot/usage-snapshot-read.error.js';

import { UsageRebuildScheduler } from './usage-rebuild-scheduler.adapter.js';

const atelierNord = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b2f';
const atelierSud = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b30';
const atelierEst = '019a5f3c-8d2e-7c4a-9b1f-3e5d7a9c1b31';
const activeSchedulers: UsageRebuildScheduler[] = [];

function fixture(enabled = true) {
  const host = new HttpAdapterHost();
  const listOrganizations = vi.fn<UsageSnapshotSource['listOrganizations']>();
  const list = vi.fn<UsageRebuildRegistryReader['list']>();
  const enroll = vi.fn<(organizationId: string) => Promise<void>>();
  const advance = vi.fn<AdvanceUsageRebuild['advance']>();
  const warn = vi.fn();
  listOrganizations.mockResolvedValue({ items: [], nextCursor: null });
  list.mockResolvedValue({ items: [], nextId: null });
  enroll.mockResolvedValue(undefined);
  advance.mockResolvedValue('healthy');

  const scheduler = new UsageRebuildScheduler(
    { listOrganizations },
    { list },
    enroll,
    { advance },
    host,
    enabled,
    { warn },
  );
  activeSchedulers.push(scheduler);
  scheduler.onApplicationBootstrap();
  return { host, scheduler, listOrganizations, list, enroll, advance };
}

function expectTenant(organizationId: string): void {
  expect(getOrganizationContext()).toEqual({
    organizationId,
    actor: { type: 'system', id: 'billing-service' },
    role: null,
    scopes: [],
  });
}

describe('billing usage rebuild scheduler', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(async () => {
    await Promise.all(activeSchedulers.splice(0).map((scheduler) => scheduler.onModuleDestroy()));
    vi.useRealTimers();
  });

  it('skips work when disabled and waits for the HTTP listener when enabled', async () => {
    const disabled = fixture(false);
    const enabled = fixture();

    disabled.host.listening = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(disabled.listOrganizations).not.toHaveBeenCalled();
    expect(disabled.list).not.toHaveBeenCalled();
    expect(enabled.listOrganizations).not.toHaveBeenCalled();
    expect(enabled.list).not.toHaveBeenCalled();

    enabled.host.listening = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(enabled.listOrganizations).toHaveBeenCalledOnce();
    expect(enabled.list).toHaveBeenCalledOnce();
  });

  it('passes the source cursor unchanged and restarts an expired roster scan globally', async () => {
    const { host, listOrganizations, list, enroll } = fixture();
    const cursor = 'opaque-roster-position';
    listOrganizations
      .mockResolvedValueOnce({ items: [atelierNord], nextCursor: cursor })
      .mockRejectedValueOnce(new UsageSnapshotReadError('invalid-cursor'))
      .mockResolvedValueOnce({ items: [atelierNord, atelierSud], nextCursor: null });
    enroll.mockImplementation((organizationId) => {
      expectTenant(organizationId);
      return Promise.resolve();
    });

    host.listening = true;
    await vi.advanceTimersByTimeAsync(6000);

    expect(listOrganizations.mock.calls.map(([query]) => [query.cursor, query.limit])).toEqual([
      [null, 25],
      [cursor, 25],
      [null, 25],
    ]);
    expect(enroll.mock.calls.map(([organizationId]) => organizationId)).toEqual([
      atelierNord,
      atelierNord,
      atelierSud,
    ]);
    expect(list).toHaveBeenCalledTimes(4);
    expect(getOrganizationContext()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(58_000);
    expect(listOrganizations).toHaveBeenCalledTimes(4);
  });

  it('retries a failed enrollment without fetching the page again or blocking registry work', async () => {
    const { host, listOrganizations, list, enroll, advance } = fixture();
    listOrganizations.mockResolvedValueOnce({
      items: [atelierNord, atelierSud, atelierEst],
      nextCursor: null,
    });
    enroll
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cannot enroll this page yet'));
    list.mockResolvedValue({ items: [atelierEst], nextId: null });
    advance.mockImplementation((organizationId) => {
      expectTenant(organizationId);
      return Promise.resolve('healthy');
    });

    host.listening = true;
    await vi.advanceTimersByTimeAsync(2000);

    expect(listOrganizations).toHaveBeenCalledOnce();
    expect(enroll.mock.calls.map(([organizationId]) => organizationId)).toEqual([
      atelierNord,
      atelierSud,
      atelierSud,
      atelierEst,
    ]);
    expect(advance.mock.calls.map(([organizationId]) => organizationId)).toEqual([
      atelierEst,
      atelierEst,
    ]);
  });

  it('paginates the local registry and gives each tenant a turn when one fails', async () => {
    const { host, listOrganizations, list, advance } = fixture();
    listOrganizations.mockRejectedValueOnce(new UsageSnapshotReadError('unavailable'));
    list
      .mockResolvedValueOnce({ items: [atelierNord, atelierSud], nextId: atelierSud })
      .mockResolvedValueOnce({ items: [atelierEst], nextId: null });
    advance.mockRejectedValueOnce(new Error('tenant step failed'));

    host.listening = true;
    await vi.advanceTimersByTimeAsync(4000);

    expect(list.mock.calls).toEqual([
      [null, 10],
      [atelierSud, 10],
      [null, 10],
    ]);
    expect(advance.mock.calls.map(([organizationId]) => organizationId)).toEqual([
      atelierNord,
      atelierSud,
      atelierEst,
    ]);
  });

  it('cancels a stalled tenant at the tick budget and resumes the registry after it', async () => {
    const { host, list, advance } = fixture();
    list
      .mockResolvedValueOnce({ items: [atelierNord, atelierSud], nextId: null })
      .mockResolvedValueOnce({ items: [atelierSud], nextId: null });
    advance.mockImplementationOnce((_organizationId, signal) => {
      return new Promise((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            resolve('waiting');
          },
          { once: true },
        );
      });
    });

    host.listening = true;
    await vi.advanceTimersByTimeAsync(7999);
    expect(list).toHaveBeenCalledOnce();
    expect(advance.mock.calls[0]?.[1]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(2001);
    expect(advance.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(list.mock.calls).toEqual([
      [null, 10],
      [atelierNord, 10],
    ]);
    expect(advance.mock.calls.map(([organizationId]) => organizationId)).toEqual([
      atelierNord,
      atelierSud,
    ]);
  });

  it('aborts and awaits in-flight work on shutdown, leaving no scheduled tick', async () => {
    const { host, scheduler, listOrganizations, list, enroll } = fixture();
    let releasePage: (page: UsageSnapshotPage<string>) => void = () => undefined;
    const sourcePage = new Promise<UsageSnapshotPage<string>>((resolve) => {
      releasePage = resolve;
    });
    listOrganizations.mockImplementationOnce(() => sourcePage);
    host.listening = true;

    try {
      await vi.advanceTimersByTimeAsync(4000);
      expect(listOrganizations).toHaveBeenCalledOnce();
      expect(list).toHaveBeenCalledOnce();

      const afterWork = vi.fn();
      const closed = scheduler.onModuleDestroy().then(afterWork);
      await Promise.resolve();
      expect(afterWork).not.toHaveBeenCalled();
      expect(listOrganizations.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      releasePage({ items: [atelierNord], nextCursor: null });
      await closed;
      expect(afterWork).toHaveBeenCalledOnce();
      expect(enroll).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releasePage({ items: [], nextCursor: null });
    }
  });
});

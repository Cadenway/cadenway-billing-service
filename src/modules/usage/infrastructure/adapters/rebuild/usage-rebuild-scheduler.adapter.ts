import { runWithOrganizationContext } from '@cadenway/nest-common';
import type { PinoLogger } from '@cadenway/nest-common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { take } from 'rxjs';
import type { Subscription } from 'rxjs';

import type { UsageSnapshotPage } from '../../../application/models/usage-snapshot/usage-snapshot-page.model.js';
import type { UsageSnapshotSource } from '../../../application/ports/outbound/http/snapshot/usage-snapshot-source.port.js';
import type { UsageRebuildRegistryReader } from '../../../application/ports/outbound/persistence/rebuild/usage-rebuild-registry-reader.port.js';
import { UsageSnapshotReadError } from '../../../domain/errors/usage-snapshot/usage-snapshot-read.error.js';

const tickIntervalMs = 2000;
const tickBudgetMs = 8000;
const rosterRefreshIntervalMs = 60_000;
const rosterPageSize = 25;
const registryPageSize = 10;

/** Polls bounded roster and registry pages after the observation consumers have subscribed. */
export class UsageRebuildScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  // #region Properties
  /** Stops future ticks and cancels any source or broker requests still running. */
  private readonly shutdown = new AbortController();

  private startRequested = false;
  private listening: Subscription | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private rosterCursor: string | null = null;
  private pendingRoster: { readonly page: UsageSnapshotPage<string>; enrolled: number } | undefined;
  private nextRosterSweep = 0;
  private registryAfterId: string | null = null;
  // #endregion

  // #region Constructor
  /** Binds the authoritative roster, local registry and tenant-scoped operations. */
  public constructor(
    private readonly source: Pick<UsageSnapshotSource, 'listOrganizations'>,
    private readonly registry: UsageRebuildRegistryReader,
    private readonly enroll: (organizationId: string) => Promise<void>,
    private readonly advance: {
      readonly advance: (organizationId: string, signal: AbortSignal) => Promise<unknown>;
    },
    private readonly httpAdapterHost: Pick<HttpAdapterHost, 'listen$' | 'listening'>,
    private readonly enabled: boolean,
    private readonly logger: Pick<PinoLogger, 'warn'>,
  ) {}
  // #endregion

  // #region Methods
  /** Waits for the listener because provider bootstrap hooks in this module run concurrently. */
  public onApplicationBootstrap(): void {
    if (!this.enabled || this.startRequested) return;
    this.startRequested = true;
    if (this.httpAdapterHost.listening) {
      this.schedule(0);
      return;
    }
    this.listening = this.httpAdapterHost.listen$.pipe(take(1)).subscribe(() => {
      this.schedule(0);
    });
  }

  /** Cancels external reads, waits for started work and prevents further ticks. */
  public async onModuleDestroy(): Promise<void> {
    this.shutdown.abort();
    this.listening?.unsubscribe();
    clearTimeout(this.timer);
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.shutdown.signal.aborted) return;

    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    const budget = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, budget.signal]);
    const timeout = setTimeout(() => {
      budget.abort();
    }, tickBudgetMs);
    timeout.unref();

    try {
      const [roster, registry] = await Promise.allSettled([
        this.scanRoster(signal),
        this.advanceRegistry(signal),
      ]);
      if (roster.status === 'rejected') this.warn('roster');
      if (registry.status === 'rejected') this.warn('registry');
    } finally {
      clearTimeout(timeout);
      this.schedule(tickIntervalMs);
    }
  }

  private async scanRoster(signal: AbortSignal): Promise<void> {
    if (Date.now() < this.nextRosterSweep) return;

    if (this.pendingRoster === undefined) {
      try {
        const page = await this.source.listOrganizations({
          cursor: this.rosterCursor,
          limit: rosterPageSize,
          signal,
        });
        this.pendingRoster = { page, enrolled: 0 };
      } catch (error) {
        if (
          error instanceof UsageSnapshotReadError &&
          error.reason === 'invalid-cursor' &&
          this.rosterCursor !== null
        ) {
          this.rosterCursor = null;
          return;
        }
        throw error;
      }
    }

    const pending = this.pendingRoster;
    for (const organizationId of pending.page.items.slice(pending.enrolled)) {
      signal.throwIfAborted();
      await this.inOrganization(organizationId, () => this.enroll(organizationId));
      pending.enrolled += 1;
    }
    this.rosterCursor = pending.page.nextCursor;
    this.pendingRoster = undefined;
    if (this.rosterCursor === null) this.nextRosterSweep = Date.now() + rosterRefreshIntervalMs;
  }

  private async advanceRegistry(signal: AbortSignal): Promise<void> {
    const page = await this.registry.list(this.registryAfterId, registryPageSize);
    let failed = false;

    for (const organizationId of page.items) {
      if (signal.aborted) break;
      // An unsuccessful tenant gets another turn on the next sweep without blocking later IDs.
      this.registryAfterId = organizationId;
      try {
        await this.inOrganization(organizationId, () =>
          this.advance.advance(organizationId, signal),
        );
      } catch {
        failed = true;
      }
    }
    if (!signal.aborted) this.registryAfterId = page.nextId;
    if (failed || signal.aborted) this.warn('tenant');
  }

  private inOrganization<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return runWithOrganizationContext(
      { organizationId, actor: { type: 'system', id: 'billing-service' }, role: null, scopes: [] },
      work,
    );
  }

  private warn(stage: 'roster' | 'registry' | 'tenant'): void {
    if (this.shutdown.signal.aborted) return;
    this.logger.warn({ component: 'usage-rebuild', stage }, 'Billing rebuild step will retry');
  }
  // #endregion
}

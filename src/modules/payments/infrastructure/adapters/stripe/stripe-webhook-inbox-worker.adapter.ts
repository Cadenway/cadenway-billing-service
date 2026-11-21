import { createHash } from 'node:crypto';

import type { PinoLogger } from '@cadenway/nest-common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { take, type Subscription } from 'rxjs';

import type { StripeWebhookLease } from '../../../application/models/webhooks/stripe-webhook-lease.model.js';
import type { StripeWebhookInbox } from '../../../application/ports/outbound/persistence/webhooks/stripe-webhook-inbox.port.js';
import type { ReconcileStripeWebhookDelivery } from '../../../application/use-cases/commands/subscriptions/reconcile-stripe-webhook-delivery/reconcile-stripe-webhook-delivery.use-case.js';

const tickIntervalMs = 2_000;
const deliveriesPerTick = 8;

/** Drains bounded leased deliveries after Billing starts listening. */
export class StripeWebhookInboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  // #region Properties
  /** Prevents new claims and scheduling after shutdown begins. */
  private stopped = false;
  private listening: Subscription | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  // #endregion

  // #region Constructor
  /** Binds the inbox, canonical settlement and the application lifecycle. */
  public constructor(
    private readonly inbox: Pick<StripeWebhookInbox, 'claim' | 'finish'>,
    private readonly reconcile: ReconcileStripeWebhookDelivery['execute'],
    private readonly host: Pick<HttpAdapterHost, 'listening' | 'listen$'>,
    private readonly logger: Pick<PinoLogger, 'warn'>,
  ) {}
  // #endregion

  // #region Methods
  /** Starts once the HTTP service has completed its bootstrap. */
  public onApplicationBootstrap(): void {
    if (this.host.listening) {
      this.schedule(0);
      return;
    }
    this.listening = this.host.listen$.pipe(take(1)).subscribe(() => {
      this.schedule(0);
    });
  }

  public async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.listening?.unsubscribe();
    clearTimeout(this.timer);
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      for (let processed = 0; processed < deliveriesPerTick && !this.stopped; processed += 1) {
        const lease = await this.inbox.claim();
        if (lease === null) return;
        await this.process(lease);
      }
    } catch {
      this.warn('claim');
    } finally {
      this.schedule(tickIntervalMs);
    }
  }

  private async process(lease: StripeWebhookLease): Promise<void> {
    let outcome: 'settled' | 'retry' = 'retry';
    try {
      outcome = await this.reconcile(lease.delivery);
    } catch {
      // Provider failures carry details that are outside this worker's logs.
    }
    try {
      if (!(await this.inbox.finish(lease, outcome))) {
        this.warn('lease', lease);
      } else if (outcome === 'retry') {
        this.warn('settlement', lease);
      }
    } catch {
      this.warn('completion', lease);
    }
  }

  private warn(
    stage: 'claim' | 'lease' | 'settlement' | 'completion',
    lease?: StripeWebhookLease,
  ): void {
    const delivery =
      lease === undefined
        ? {}
        : {
            kind: lease.delivery.kind,
            attempt: lease.attempt,
            ageMs: Math.max(Date.now() - lease.admittedAt.getTime(), 0),
            deliveryDigest: createHash('sha256').update(lease.delivery.eventId).digest('hex'),
          };
    this.logger.warn(
      { component: 'stripe-webhook-inbox', stage, ...delivery },
      'Stripe webhook work remains pending',
    );
  }
  // #endregion
}

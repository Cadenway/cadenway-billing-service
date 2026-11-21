import { DEFAULT_EVENTS_STREAM } from '@cadenway/nest-messaging';

import type { UsageRebuildBrokerProgress } from '../../../application/models/rebuild/usage-rebuild-broker-progress.model.js';
import type { UsageBrokerProof } from '../../../application/ports/outbound/messaging/rebuild/usage-broker-proof.port.js';

type ConsumerProgress = UsageRebuildBrokerProgress['consumers'][number];

/** Compares JetStream observations across the authoritative usage export. */
export class BillingUsageBrokerProof implements UsageBrokerProof {
  // #region Properties
  /** Exact local names of the projection's durable consumers. */
  private readonly requiredHandlers: ReadonlySet<string>;
  // #endregion

  // #region Constructor
  /** Receives the local names for every handler that can change the projection. */
  public constructor(handlerNames: readonly string[]) {
    this.requiredHandlers = new Set(handlerNames);
  }
  // #endregion

  // #region Methods
  /** Starts the export only after capturing the complete projection and clearing advisory checks. */
  public validStart(start: UsageRebuildBrokerProgress, advisoriesClear: boolean): boolean {
    return advisoriesClear && this.readConsumers(start) !== null;
  }

  /** Separates a confirmed break in continuity from lag or unavailable evidence. */
  public assess(
    start: UsageRebuildBrokerProgress,
    finish: UsageRebuildBrokerProgress,
    advisoriesClear: boolean,
  ): ReturnType<UsageBrokerProof['assess']> {
    const originalConsumers = this.readConsumers(start);
    if (originalConsumers === null) {
      return 'lost';
    }

    const currentConsumers = this.readConsumers(finish);
    if (currentConsumers === null) {
      return 'pending';
    }
    if (lostStreamContinuity(start, finish)) {
      return 'lost';
    }

    for (const [handler, original] of originalConsumers) {
      const current = currentConsumers.get(handler);
      if (
        current?.createdAt !== original.createdAt ||
        current.deliveredSequence < original.deliveredSequence ||
        current.ackFloorSequence < original.ackFloorSequence
      ) {
        return 'lost';
      }
    }

    // The kit reads each durable after sampling the stream head. JetStream can advance delivery
    // past unrelated subjects without changing the ACK floor, so use the two backlog counters.
    return advisoriesClear && finish.consumers.every(consumedThroughSample) ? 'covered' : 'pending';
  }

  /** Validates persisted evidence and indexes the exact set of consumer identities. */
  private readConsumers(
    progress: UsageRebuildBrokerProgress,
  ): ReadonlyMap<string, ConsumerProgress> | null {
    if (
      progress.stream !== DEFAULT_EVENTS_STREAM ||
      !isBrokerTimestamp(progress.createdAt) ||
      ![progress.firstSequence, progress.lastSequence, progress.retainedGapCount].every(isCount) ||
      progress.firstSequence - 1 > progress.lastSequence ||
      progress.retainedGapCount - 1 > progress.lastSequence - progress.firstSequence ||
      progress.consumers.length !== this.requiredHandlers.size ||
      this.requiredHandlers.size === 0
    ) {
      return null;
    }

    const consumers = new Map<string, ConsumerProgress>();
    for (const consumer of progress.consumers) {
      if (
        !this.requiredHandlers.has(consumer.handler) ||
        consumers.has(consumer.handler) ||
        !isBrokerTimestamp(consumer.createdAt) ||
        ![
          consumer.deliveredSequence,
          consumer.ackFloorSequence,
          consumer.pending,
          consumer.ackPending,
        ].every(isCount) ||
        consumer.ackFloorSequence > consumer.deliveredSequence
      ) {
        return null;
      }
      consumers.set(consumer.handler, consumer);
    }
    return consumers;
  }
  // #endregion
}

/** Validates a nonnegative stream position or count that can be represented losslessly. */
function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Validates broker timestamps while preserving all digits for identity comparisons. */
function isBrokerTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Detects a replaced stream, retention past the export fence, or unprovable retained gaps. */
function lostStreamContinuity(
  start: UsageRebuildBrokerProgress,
  finish: UsageRebuildBrokerProgress,
): boolean {
  if (
    finish.createdAt !== start.createdAt ||
    finish.firstSequence < start.firstSequence ||
    finish.lastSequence < start.lastSequence ||
    finish.firstSequence - 1 > start.lastSequence
  ) {
    return true;
  }

  // Prefix retention can remove old interior gaps while new ones appear. An unchanged,
  // nonzero gap count only proves continuity when the retention floor also stayed fixed.
  return (
    finish.lastSequence > start.lastSequence &&
    finish.retainedGapCount > 0 &&
    (finish.retainedGapCount !== start.retainedGapCount ||
      finish.firstSequence !== start.firstSequence)
  );
}

/** Confirms a filtered consumer drained both undelivered and unacknowledged work. */
function consumedThroughSample(consumer: ConsumerProgress): boolean {
  return consumer.pending === 0 && consumer.ackPending === 0;
}

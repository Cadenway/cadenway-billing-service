import { DEFAULT_EVENTS_STREAM, durableConsumerName } from '@cadenway/nest-messaging';
import type { EventConsumers, MessagingConnection } from '@cadenway/nest-messaging';

import type { UsageBrokerSample } from '../../../application/models/rebuild/usage-broker-sample.model.js';
import type { UsageBrokerSampleReader } from '../../../application/ports/outbound/messaging/rebuild/usage-broker-sample-reader.port.js';

const advisoryStream = 'BILLING_REBUILD_ADVISORIES';

/** Reads only the event stream and the durables that feed the Billing usage projection. */
export class JetStreamUsageBrokerProgressAdapter implements UsageBrokerSampleReader {
  // #region Properties
  /** Broker names used by the terminal advisory subjects. */
  private readonly durables: readonly string[];
  // #endregion

  // #region Constructor
  /** Takes the same local names used to register the Billing handlers. */
  public constructor(
    private readonly connection: Pick<
      MessagingConnection,
      'isConsumerAdvisoryStreamClear' | 'watchAvailability'
    >,
    private readonly consumers: Pick<EventConsumers, 'readProgress'>,
    private readonly handlerNames: readonly string[],
  ) {
    this.durables = handlerNames.map((name) => durableConsumerName('billing-service', name));
  }
  // #endregion

  // #region Methods
  /** Takes a sample bounded by the caller's signal and a single available interval. */
  public async read(signal?: AbortSignal): Promise<UsageBrokerSample | null> {
    const availability = new AbortController();
    const cancellation =
      signal === undefined ? availability.signal : AbortSignal.any([availability.signal, signal]);
    const stopWatching = this.connection.watchAvailability((available) => {
      if (!available) {
        availability.abort();
      }
    });

    try {
      cancellation.throwIfAborted();
      const clearBefore = await this.readAdvisories(cancellation);
      cancellation.throwIfAborted();

      const progress = await this.consumers.readProgress(this.handlerNames, cancellation);
      if (progress?.stream !== DEFAULT_EVENTS_STREAM) {
        return null;
      }
      cancellation.throwIfAborted();

      // Read again even when the first result is unclear. An advisory between either read
      // and the consumer sample leaves this observation unsuitable for promotion.
      const clearAfter = await this.readAdvisories(cancellation);
      cancellation.throwIfAborted();
      return { progress, advisoriesClear: clearBefore && clearAfter };
    } catch (error) {
      if (cancellation.aborted) {
        return null;
      }
      throw error;
    } finally {
      stopWatching();
    }
  }

  /** Uses the shared kit to verify the complete advisory configuration. */
  private readAdvisories(signal: AbortSignal): Promise<boolean> {
    return this.connection.isConsumerAdvisoryStreamClear(
      advisoryStream,
      DEFAULT_EVENTS_STREAM,
      this.durables,
      signal,
    );
  }
  // #endregion
}

/** A bounded observation of the event stream and each required durable consumer. */
export interface UsageRebuildBrokerProgress {
  // #region Properties
  /** Stable stream name and precise broker creation timestamp. */
  readonly stream: string;
  readonly createdAt: string;

  /** Retention window and its reported deleted positions. */
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly retainedGapCount: number;

  /** Identity and progress of each subscribed source handler. */
  readonly consumers: readonly {
    readonly handler: string;
    readonly createdAt: string;
    readonly deliveredSequence: number;
    readonly ackFloorSequence: number;
    readonly pending: number;
    readonly ackPending: number;
  }[];
  // #endregion
}

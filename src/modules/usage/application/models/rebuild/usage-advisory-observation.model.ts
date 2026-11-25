/** Identity and sequence of a confirmed clear advisory latch. */
export interface UsageAdvisoryObservation {
  // #region Properties
  /** Latch creation time and last assigned sequence. */
  readonly createdAt: string;
  readonly lastSequence: number;
  // #endregion
}

/** Compares persisted latch evidence with a fresh observation. */
export function sameAdvisoryObservation(
  left: UsageAdvisoryObservation | null,
  right: UsageAdvisoryObservation | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.createdAt === right.createdAt &&
    left.lastSequence === right.lastSequence
  );
}

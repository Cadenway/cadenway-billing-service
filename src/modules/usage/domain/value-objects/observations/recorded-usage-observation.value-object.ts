import type { UsageObservation } from './usage-observation.value-object.js';

/** Versioned state of a single membership or verified attachment in the usage projection. */
export type RecordedUsageObservation =
  | {
      readonly source: 'membership';
      readonly sourceId: string;
      readonly observation: UsageObservation<'owner' | 'admin' | 'member' | 'guest'>;
    }
  | {
      readonly source: 'attachment';
      readonly sourceId: string;
      readonly observation: UsageObservation<number>;
    };

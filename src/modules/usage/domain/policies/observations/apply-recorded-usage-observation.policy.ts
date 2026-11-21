import { RecordedUsageObservationError } from '../../errors/observations/recorded-usage-observation.error.js';
import type { RecordedUsageObservation } from '../../value-objects/observations/recorded-usage-observation.value-object.js';
import type { UsageTotals } from '../../value-objects/observations/usage-totals.value-object.js';
import { attachmentUsageBytes } from '../attachments/attachment-usage.policy.js';
import { membershipUsage } from '../memberships/membership-usage.policy.js';

import { applyUsageObservation } from './apply-usage-observation.policy.js';

const emptyContribution: UsageTotals = { seats: 0, guests: 0, storageBytes: 0 };

/**
 * Applies a versioned observation and replaces its prior contribution in the generation totals.
 * A stale or repeated observation leaves both the source row and the totals untouched.
 */
export function applyRecordedUsageObservation(
  current: RecordedUsageObservation | null,
  incoming: RecordedUsageObservation,
  totals: UsageTotals,
): { readonly observation: RecordedUsageObservation; readonly totals: UsageTotals } | null {
  if (current && (current.source !== incoming.source || current.sourceId !== incoming.sourceId)) {
    throw new RecordedUsageObservationError('mismatched-locator');
  }

  const ordered =
    incoming.source === 'membership'
      ? applyUsageObservation(
          current?.source === 'membership' ? current.observation : null,
          incoming.observation,
        )
      : applyUsageObservation(
          current?.source === 'attachment' ? current.observation : null,
          incoming.observation,
        );
  if (ordered === current?.observation) return null;

  const before = contribution(current);
  const after = contribution(incoming);

  return {
    observation: incoming,
    totals: {
      seats: replaceContribution(totals.seats, before.seats, after.seats),
      guests: replaceContribution(totals.guests, before.guests, after.guests),
      storageBytes: replaceContribution(
        totals.storageBytes,
        before.storageBytes,
        after.storageBytes,
      ),
    },
  };
}

function contribution(record: RecordedUsageObservation | null): UsageTotals {
  if (record?.observation.state !== 'present') return emptyContribution;
  if (record.source === 'membership') {
    return {
      ...membershipUsage({ state: 'active', role: record.observation.value }),
      storageBytes: 0,
    };
  }
  return {
    seats: 0,
    guests: 0,
    storageBytes: attachmentUsageBytes({
      state: 'ready',
      verifiedSizeBytes: record.observation.value,
    }),
  };
}

function replaceContribution(total: number, previous: number, next: number): number {
  const updated = total - previous + next;
  if (!Number.isSafeInteger(total) || total < previous || !Number.isSafeInteger(updated)) {
    throw new RecordedUsageObservationError('invalid-totals');
  }
  return updated;
}

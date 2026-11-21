import { describe, expect, it } from 'vitest';

import { RecordedUsageObservationError } from '../../errors/observations/recorded-usage-observation.error.js';
import type { RecordedUsageObservation } from '../../value-objects/observations/recorded-usage-observation.value-object.js';
import { applyRecordedUsageObservation } from './apply-recorded-usage-observation.policy.js';

const totals = { seats: 3, guests: 1, storageBytes: 128 };
const guest = {
  source: 'membership',
  sourceId: 'membership-a',
  observation: { state: 'present', version: 1, value: 'guest' },
} as const satisfies RecordedUsageObservation;
const attachment = {
  source: 'attachment',
  sourceId: 'attachment-a',
  observation: { state: 'present', version: 2, value: 128 },
} as const satisfies RecordedUsageObservation;

describe('recorded usage reconciliation', () => {
  it('moves a promoted guest into billed seats without affecting verified bytes', () => {
    const promoted = {
      ...guest,
      observation: { state: 'present', version: 2, value: 'member' },
    } as const;

    expect(applyRecordedUsageObservation(guest, promoted, totals)).toEqual({
      observation: promoted,
      totals: { seats: 4, guests: 0, storageBytes: 128 },
    });
    expect(applyRecordedUsageObservation(promoted, guest, totals)).toBeNull();
  });

  it('removes only the recorded bytes once and records the terminal version on an import', () => {
    const deleted = { ...attachment, observation: { state: 'absent', version: 2 } } as const;

    expect(applyRecordedUsageObservation(attachment, deleted, totals)).toEqual({
      observation: deleted,
      totals: { seats: 3, guests: 1, storageBytes: 0 },
    });
    expect(applyRecordedUsageObservation(null, deleted, totals)).toEqual({
      observation: deleted,
      totals,
    });
    expect(applyRecordedUsageObservation(deleted, attachment, totals)).toBeNull();
    expect(applyRecordedUsageObservation(deleted, deleted, totals)).toBeNull();
  });

  it('refuses to combine observations of different locators', () => {
    expect(() => applyRecordedUsageObservation(guest, attachment, totals)).toThrow(
      RecordedUsageObservationError,
    );
    expect(() =>
      applyRecordedUsageObservation(guest, { ...guest, sourceId: 'membership-b' }, totals),
    ).toThrow(RecordedUsageObservationError);
  });

  it('detects a missing recorded contribution even if its replacement has the same value', () => {
    const repeatedSize = {
      ...attachment,
      observation: { ...attachment.observation, version: 3 },
    };

    expect(() =>
      applyRecordedUsageObservation(attachment, repeatedSize, { ...totals, storageBytes: 0 }),
    ).toThrow(RecordedUsageObservationError);
  });

  it('refuses an aggregate that would overflow exact integer storage', () => {
    expect(() =>
      applyRecordedUsageObservation(null, attachment, {
        ...totals,
        storageBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(RecordedUsageObservationError);
  });
});

import { describe, expect, it } from 'vitest';

import { UsageObservationError } from '../../errors/observations/usage-observation.error.js';
import type { UsageObservation } from '../../value-objects/observations/usage-observation.value-object.js';
import { applyUsageObservation } from './apply-usage-observation.policy.js';

describe('usage observation ordering', () => {
  it('applies a newer membership role and ignores older or duplicate role observations', () => {
    const joined = { state: 'present', version: 1, value: 'guest' } as const;
    const promoted = { state: 'present', version: 2, value: 'member' } as const;

    expect(applyUsageObservation<'guest' | 'member'>(joined, promoted)).toBe(promoted);
    expect(applyUsageObservation<'guest' | 'member'>(promoted, joined)).toBe(promoted);
    expect(applyUsageObservation<string>(promoted, { ...promoted })).toBe(promoted);
  });

  it('keeps a membership removal over an equal or higher version role for the same locator', () => {
    const member = { state: 'present', version: 2, value: 'member' } as const;
    const removed = { state: 'absent', version: 2 } as const;

    expect(applyUsageObservation(member, removed)).toBe(removed);
    expect(applyUsageObservation(removed, member)).toBe(removed);
    expect(applyUsageObservation(removed, { ...member, version: 3 })).toBe(removed);
    expect(applyUsageObservation(removed, { ...removed })).toBe(removed);
  });

  it('bootstraps from a deleted file and keeps that locator absent during an import', () => {
    const deleted = { state: 'absent', version: 2 } as const;
    const uploaded = { state: 'present', version: 1, value: 256 } as const;
    const newerDeletion = { state: 'absent', version: 3 } as const;

    expect(applyUsageObservation(null, deleted)).toBe(deleted);
    expect(applyUsageObservation(deleted, uploaded)).toBe(deleted);
    expect(applyUsageObservation(deleted, newerDeletion)).toBe(newerDeletion);
    expect(applyUsageObservation(newerDeletion, deleted)).toBe(newerDeletion);
    expect(applyUsageObservation(null, uploaded)).toBe(uploaded);
  });

  it('ignores delayed observations older than an imported row', () => {
    const imported = { state: 'present', version: 3, value: 256 } as const;
    const uploaded = { state: 'present', version: 1, value: 256 } as const;

    expect(applyUsageObservation(null, imported)).toBe(imported);
    expect(applyUsageObservation(imported, uploaded)).toBe(imported);
    expect(applyUsageObservation(imported, { state: 'absent', version: 2 })).toBe(imported);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses an invalid observation version %s',
    (version) => {
      const invalid: UsageObservation<number> = { state: 'absent', version };
      const valid: UsageObservation<number> = { state: 'absent', version: 1 };

      expect(() => applyUsageObservation(valid, invalid)).toThrow(UsageObservationError);
      expect(() => applyUsageObservation(invalid, valid)).toThrow(UsageObservationError);
    },
  );

  it('accepts the maximum safe version', () => {
    const terminal = { state: 'absent', version: Number.MAX_SAFE_INTEGER } as const;

    expect(applyUsageObservation(null, terminal)).toBe(terminal);
  });
});

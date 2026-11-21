import { UsageObservationError } from '../../errors/observations/usage-observation.error.js';
import type { UsageObservation } from '../../value-objects/observations/usage-observation.value-object.js';

/**
 * Applies an event or an import row to the same tenant, source locator and projection generation.
 * Organization and Storage AsyncAPI order membership and file facts by version. Their source IDs
 * are never reused, so a terminal observation prevails on a tie and prevents resurrection.
 * A generation with no stored row accepts either state. The original row is returned on a no-op.
 * @throws {UsageObservationError} When either observation version is invalid.
 */
export function applyUsageObservation<T>(
  current: UsageObservation<T> | null,
  incoming: UsageObservation<T>,
): UsageObservation<T> {
  assertValidVersion(incoming.version);
  if (current === null) return incoming;
  assertValidVersion(current.version);

  if (current.state === 'absent' && incoming.state === 'present') return current;
  if (incoming.version > current.version) return incoming;
  if (incoming.version === current.version && incoming.state === 'absent') {
    return current.state === 'present' ? incoming : current;
  }
  return current;
}

function assertValidVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) throw new UsageObservationError();
}

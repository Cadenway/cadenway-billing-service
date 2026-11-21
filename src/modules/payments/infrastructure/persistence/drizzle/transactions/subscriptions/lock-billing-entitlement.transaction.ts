import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';

/** Serializes committed quota writes with reads that drive Usage side effects. */
export async function lockBillingEntitlement(
  scope: TransactionScope<DatabaseSchema>,
  organizationId: string,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  const key = `billing.entitlement:${organizationId.toLowerCase()}`;
  if (mode === 'shared') {
    await scope.client.query('select pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [key]);
    return;
  }
  await scope.client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

import { runWithOrganizationContext } from '@cadenway/nest-common';

/** Runs Stripe delivery work in a Billing-owned system context. */
export function runStripeBillingScope<T>(
  organizationId: string | null,
  work: () => Promise<T>,
): Promise<T> {
  return runWithOrganizationContext(
    { organizationId, actor: { type: 'system', id: 'billing-service' }, role: null, scopes: [] },
    work,
  );
}

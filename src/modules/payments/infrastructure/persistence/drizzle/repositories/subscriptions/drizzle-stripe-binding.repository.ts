import type { DatabaseSchema, TenantTransactionRunner } from '@cadenway/nest-common/database';
import { eq } from 'drizzle-orm';

import type { StripeBindingReader } from '../../../../../application/ports/outbound/persistence/subscriptions/stripe-binding-reader.port.js';
import { stripeBindings } from '../../schemas/subscriptions/stripe-subscriptions.schema.js';

/** Reads the verified provider binding inside the requested tenant. */
export class DrizzleStripeBindingReader implements StripeBindingReader {
  // #region Constructor
  /** Uses the shared tenant transaction runner. */
  public constructor(private readonly runner: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Reads a single binding with an explicit tenant predicate. */
  public read(organizationId: string): ReturnType<StripeBindingReader['read']> {
    return this.runner.run(
      async (scope) => {
        if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
          throw new Error('Stripe binding organization does not match the tenant scope.');
        }
        const [row] = await scope.db
          .select()
          .from(stripeBindings)
          .where(eq(stripeBindings.organizationId, organizationId))
          .limit(1);
        return row === undefined
          ? null
          : {
              revision: row.version,
              binding: { customerId: row.customerId, subscriptionId: row.subscriptionId },
            };
      },
      { readOnly: true },
    );
  }
  // #endregion
}

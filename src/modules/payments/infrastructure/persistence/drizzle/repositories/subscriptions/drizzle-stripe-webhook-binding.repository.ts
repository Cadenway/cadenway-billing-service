import { getOrganizationContext } from '@cadenway/nest-common';
import type { DatabaseSchema, SystemTransactionRunner } from '@cadenway/nest-common/database';
import { and, eq } from 'drizzle-orm';

import type { StripeWebhookBindingReader } from '../../../../../application/ports/outbound/persistence/subscriptions/stripe-webhook-binding-reader.port.js';
import { stripeBindings } from '../../schemas/subscriptions/stripe-subscriptions.schema.js';

const providerId = /^[\x21-\x7e]{1,255}$/u;

/** Resolves verified Stripe identities through the current Billing binding. */
export class DrizzleStripeWebhookBindingReader implements StripeWebhookBindingReader {
  // #region Constructor
  /** Binds the provider lookup to the shared system transaction runner. */
  public constructor(private readonly runner: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Returns the binding token for one exact, configured-account provider pair. */
  public async resolve(
    identity: Parameters<StripeWebhookBindingReader['resolve']>[0],
  ): ReturnType<StripeWebhookBindingReader['resolve']> {
    const context = getOrganizationContext();
    if (context?.organizationId !== null || context.actor.type !== 'system') {
      throw new Error('Stripe webhook binding resolution requires a global system actor.');
    }
    if (
      identity.account !== null ||
      identity.authContext !== null ||
      !providerId.test(identity.customerId) ||
      !providerId.test(identity.subscriptionId)
    ) {
      return null;
    }

    return this.runner.run(
      async (scope) => {
        if (scope.kind !== 'system' || scope.organizationId !== null) {
          throw new Error('Stripe webhook binding resolution requires system scope.');
        }
        const rows = await scope.db
          .select({
            organizationId: stripeBindings.organizationId,
            customerId: stripeBindings.customerId,
            subscriptionId: stripeBindings.subscriptionId,
            revision: stripeBindings.version,
          })
          .from(stripeBindings)
          .where(
            and(
              eq(stripeBindings.customerId, identity.customerId),
              eq(stripeBindings.subscriptionId, identity.subscriptionId),
            ),
          )
          .limit(2);
        const [row] = rows;
        return rows.length === 1 && row !== undefined
          ? {
              organizationId: row.organizationId,
              revision: row.revision,
              binding: { customerId: row.customerId, subscriptionId: row.subscriptionId },
            }
          : null;
      },
      { readOnly: true },
    );
  }
  // #endregion
}

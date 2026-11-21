import { getOrganizationContext } from '@cadenway/nest-common';
import type {
  DatabaseSchema,
  SystemTransactionRunner,
  TransactionScope,
} from '@cadenway/nest-common/database';
import { and, eq } from 'drizzle-orm';

import type { StripeWebhookBindingReader } from '../../../../../application/ports/outbound/persistence/subscriptions/stripe-webhook-binding-reader.port.js';
import {
  stripeBindings,
  stripeReconciliationReceipts,
} from '../../schemas/subscriptions/stripe-subscriptions.schema.js';

const providerId = /^[\x21-\x7e]{1,255}$/u;

/** Resolves verified Stripe identities through the current Billing binding. */
export class DrizzleStripeWebhookBindingReader implements StripeWebhookBindingReader {
  // #region Constructor
  /** Binds the provider lookup to the shared system transaction runner. */
  public constructor(private readonly runner: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Looks up a previously settled event without exposing its tenant. */
  public async hasSettlement(eventId: string): Promise<boolean> {
    return this.read(async (scope) => {
      const [receipt] = await scope.db
        .select({ eventId: stripeReconciliationReceipts.eventId })
        .from(stripeReconciliationReceipts)
        .where(eq(stripeReconciliationReceipts.eventId, eventId))
        .limit(1);
      return receipt !== undefined;
    });
  }

  /** Returns the binding token for one exact, configured-account provider pair. */
  public async resolve(
    identity: Parameters<StripeWebhookBindingReader['resolve']>[0],
  ): ReturnType<StripeWebhookBindingReader['resolve']> {
    if (
      identity.account !== null ||
      identity.authContext !== null ||
      !providerId.test(identity.customerId) ||
      !providerId.test(identity.subscriptionId)
    ) {
      return null;
    }

    return this.read(async (scope) => {
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
    });
  }

  /** Restricts account-wide reads to the verified global system context. */
  private read<T>(query: (scope: TransactionScope<DatabaseSchema>) => Promise<T>): Promise<T> {
    const context = getOrganizationContext();
    if (context?.organizationId !== null || context.actor.type !== 'system') {
      throw new Error('Stripe webhook resolution requires a global system actor.');
    }
    return this.runner.run(
      async (scope) => {
        if (scope.kind !== 'system' || scope.organizationId !== null) {
          throw new Error('Stripe webhook resolution requires system scope.');
        }
        return await query(scope);
      },
      { readOnly: true },
    );
  }
  // #endregion
}

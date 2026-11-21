import { getOrganizationContext } from '@cadenway/nest-common';
import type {
  DatabaseSchema,
  SystemTransactionRunner,
  TransactionScope,
} from '@cadenway/nest-common/database';
import { eq, sql } from 'drizzle-orm';

import type { StripeCheckoutAttemptReader } from '../../../../../application/ports/outbound/persistence/checkout/stripe-checkout-attempt-reader.port.js';
import {
  stripeCheckoutAttempts,
  stripeCheckoutReceipts,
} from '../../schemas/checkout/stripe-checkout.schema.js';

const providerIdentity = /^[\x21-\x7e]{1,255}$/u;

/** Resolves an exact Checkout identity after admission of a signed webhook. */
export class DrizzleStripeCheckoutAttemptReader implements StripeCheckoutAttemptReader {
  // #region Constructor
  /** Uses the organization-free system scope for provider lookups. */
  public constructor(private readonly runner: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Checks whether the exact provider event was already settled. */
  public async hasSettlement(eventId: string): Promise<boolean> {
    if (!providerIdentity.test(eventId)) return false;
    return this.read(async (scope) => {
      await scope.db.execute(
        sql`select set_config('app.stripe_checkout_event_id', ${eventId}, true)`,
      );
      const [row] = await scope.db
        .select({ eventId: stripeCheckoutReceipts.eventId })
        .from(stripeCheckoutReceipts)
        .where(eq(stripeCheckoutReceipts.eventId, eventId))
        .limit(1);
      return row !== undefined;
    });
  }

  /** Reads only the tenant recorded by Billing for this exact provider key. */
  public async resolve(providerKey: string): ReturnType<StripeCheckoutAttemptReader['resolve']> {
    if (!providerIdentity.test(providerKey)) return null;
    return this.read(async (scope) => {
      await scope.db.execute(
        sql`select set_config('app.stripe_checkout_provider_key', ${providerKey}, true)`,
      );
      const [row] = await scope.db
        .select({ organizationId: stripeCheckoutAttempts.organizationId })
        .from(stripeCheckoutAttempts)
        .where(eq(stripeCheckoutAttempts.providerKey, providerKey))
        .limit(1);
      return row ?? null;
    });
  }

  /** Allows the lookup only in the webhook's organization-free system context. */
  private read<T>(query: (scope: TransactionScope<DatabaseSchema>) => Promise<T>): Promise<T> {
    const caller = getOrganizationContext();
    if (caller?.organizationId !== null || caller.actor.type !== 'system') {
      throw new Error('Stripe Checkout resolution requires a global system actor.');
    }
    return this.runner.run(query, { readOnly: true });
  }
  // #endregion
}

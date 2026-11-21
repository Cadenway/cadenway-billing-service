import { randomUUID } from 'node:crypto';

import { getOrganizationContext } from '@cadenway/nest-common';
import {
  assertNoActiveTransaction,
  type DatabaseSchema,
  type SystemTransactionRunner,
} from '@cadenway/nest-common/database';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';

import type { StripeWebhookDelivery } from '../../../../../application/models/webhooks/stripe-webhook-delivery.model.js';
import type { StripeWebhookLease } from '../../../../../application/models/webhooks/stripe-webhook-lease.model.js';
import { stripeWebhookInbox } from '../../schemas/webhooks/stripe-webhook-inbox.schema.js';

/** Leases the next due Stripe delivery without holding a transaction during settlement. */
export class DrizzleStripeWebhookInboxClaim {
  // #region Constructor
  /** Claims due events under the service-owned system transaction. */
  public constructor(private readonly system: SystemTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Restricts cross-tenant selection to the Billing background worker. */
  public claim(): Promise<StripeWebhookLease | null> {
    assertNoActiveTransaction();
    const context = getOrganizationContext();
    if (
      context?.organizationId !== null ||
      context.actor.type !== 'system' ||
      context.actor.id !== 'billing-service'
    ) {
      throw new Error('Stripe webhook claiming requires the Billing system actor.');
    }
    const token = randomUUID();
    return this.system.run(async ({ db }) => {
      await db.execute(sql`select set_config('app.stripe_webhook_inbox_work', 'on', true)`);
      const [pending] = await db
        .select({
          eventId: stripeWebhookInbox.eventId,
          organizationId: stripeWebhookInbox.organizationId,
          kind: stripeWebhookInbox.kind,
          sessionId: stripeWebhookInbox.sessionId,
          customerId: stripeWebhookInbox.customerId,
          subscriptionId: stripeWebhookInbox.subscriptionId,
          admittedAt: stripeWebhookInbox.createdAt,
        })
        .from(stripeWebhookInbox)
        .where(
          and(
            isNull(stripeWebhookInbox.finishedAt),
            lte(stripeWebhookInbox.availableAt, sql`now()`),
          ),
        )
        .orderBy(stripeWebhookInbox.availableAt, stripeWebhookInbox.eventId)
        .limit(1)
        .for('update', { skipLocked: true });
      if (pending === undefined) return null;

      const delivery = identity(pending);
      const [claim] = await db
        .update(stripeWebhookInbox)
        .set({
          availableAt: sql`now() + interval '60 seconds'`,
          updatedAt: sql`now()`,
          leaseToken: token,
          claimCount: sql`least(${stripeWebhookInbox.claimCount} + 1, 1000000)`,
        })
        .where(
          and(
            eq(stripeWebhookInbox.organizationId, delivery.organizationId),
            eq(stripeWebhookInbox.eventId, delivery.eventId),
          ),
        )
        .returning({ attempt: stripeWebhookInbox.claimCount });
      if (claim === undefined) throw new Error('Stripe webhook claim was not recorded.');
      return { delivery, token, attempt: claim.attempt, admittedAt: pending.admittedAt };
    });
  }
  // #endregion
}

/** Maps only identities admitted by the database's discriminated shape check. */
function identity(
  row: Pick<
    typeof stripeWebhookInbox.$inferSelect,
    'kind' | 'organizationId' | 'eventId' | 'sessionId' | 'customerId' | 'subscriptionId'
  >,
): StripeWebhookDelivery {
  const { kind, organizationId, eventId, sessionId, customerId, subscriptionId } = row;
  if (kind === 'checkout' && sessionId !== null) {
    return { kind, organizationId, eventId, sessionId };
  }
  if (kind === 'subscription' && customerId !== null && subscriptionId !== null) {
    return { kind, organizationId, eventId, customerId, subscriptionId };
  }
  throw new Error('Stored Stripe webhook has an invalid identity.');
}

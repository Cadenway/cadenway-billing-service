import { createHash, randomBytes } from 'node:crypto';

import {
  assertNoActiveTransaction,
  type DatabaseSchema,
  type TenantTransactionRunner,
  type TransactionScope,
} from '@cadenway/nest-common/database';
import { z } from 'zod';

import type { CheckoutClaim } from '../../../../../application/models/checkout/checkout-claim.model.js';
import type { CheckoutProviderRequest } from '../../../../../application/models/checkout/checkout-provider-request.model.js';
import type { CheckoutUnitOfWork } from '../../../../../application/ports/outbound/transactions/checkout/checkout-unit-of-work.port.js';
import type { StartBillingCheckoutInput } from '../../../../../application/use-cases/commands/checkout/start-billing-checkout/start-billing-checkout.input.js';
import { lockBillingEntitlement } from '../subscriptions/lock-billing-entitlement.transaction.js';

const checkoutRowSchema = z.object({
  id: z.uuid(),
  plan: z.string(),
  provider_key: z.string(),
  price_id: z.string().nullable(),
  quantity: z.string().nullable(),
  success_url: z.string().nullable(),
  cancel_url: z.string().nullable(),
  response_url: z.string().nullable(),
  provider_started: z.boolean(),
  provider_retained: z.boolean().nullable(),
  replayable: z.boolean().nullable(),
  leased: z.boolean().nullable(),
  resolved: z.boolean(),
});

type CheckoutRow = z.infer<typeof checkoutRowSchema>;

/** Serializes durable checkout leases without holding a transaction over provider I/O. */
export class DrizzleCheckoutUnitOfWork implements CheckoutUnitOfWork {
  // #region Constructor
  /** Requires the tenant-scoped transaction runner. */
  public constructor(private readonly runner: TenantTransactionRunner<DatabaseSchema>) {}
  // #endregion

  // #region Methods
  /** Claims one tenant reservation, or returns its prior outcome. */
  public async claim(input: StartBillingCheckoutInput): Promise<CheckoutClaim> {
    assertNoActiveTransaction();
    const digest = createHash('sha256').update(input.idempotencyKey, 'utf8').digest('hex');
    return this.runner.run(async (scope) => {
      this.assertTenant(scope, input.organizationId);
      await lockBillingEntitlement(scope, input.organizationId, 'shared');
      await this.lockCheckout(scope, input.organizationId);
      const found = await scope.client.query(
        `select id, plan, provider_key, price_id, quantity, success_url, cancel_url, response_url,
           provider_started_at is not null as provider_started,
           provider_started_at > clock_timestamp() - interval '23 hours 55 minutes' as provider_retained,
           completed_at > clock_timestamp() - interval '24 hours' as replayable,
           lease_expires_at > clock_timestamp() as leased,
           resolved_at is not null as resolved
         from stripe_checkout_attempts
         where organization_id = $1 and actor_id = $2 and key_digest = $3
         limit 1 for update`,
        [input.organizationId, input.actorId, digest],
      );
      const existing =
        found.rows[0] === undefined ? undefined : checkoutRowSchema.parse(found.rows[0]);
      if (existing) {
        if (existing.plan !== input.plan) return { status: 'key-reused' };
        if (existing.response_url !== null) {
          return existing.replayable
            ? { status: 'replay', url: existing.response_url }
            : { status: 'unavailable' };
        }
      }

      const subscription = await scope.client.query(
        `select binding.organization_id, snapshot.plan
         from stripe_bindings binding
         left join stripe_subscription_snapshots snapshot using (organization_id)
         where binding.organization_id = $1 limit 1`,
        [input.organizationId],
      );
      if (subscription.rows[0] !== undefined) {
        const { plan } = z.object({ plan: z.string().nullable() }).parse(subscription.rows[0]);
        return { status: plan === 'team' ? 'subscription-active' : 'unavailable' };
      }

      if (existing) {
        if (existing.resolved || (existing.provider_started && !existing.provider_retained)) {
          return { status: 'unavailable' };
        }
        if (existing.leased) return { status: 'request-in-progress' };
        return this.claimRow(scope, input.organizationId, existing);
      }

      const active = await scope.client.query(
        `select id, plan, provider_key, price_id, quantity, success_url, cancel_url, response_url,
           provider_started_at is not null as provider_started,
           provider_started_at > clock_timestamp() - interval '23 hours 55 minutes' as provider_retained,
           completed_at > clock_timestamp() - interval '24 hours' as replayable,
           lease_expires_at > clock_timestamp() as leased,
           resolved_at is not null as resolved
         from stripe_checkout_attempts
         where organization_id = $1 and resolved_at is null
         limit 1 for update`,
        [input.organizationId],
      );
      const open =
        active.rows[0] === undefined ? undefined : checkoutRowSchema.parse(active.rows[0]);
      if (open) {
        if (open.provider_started || open.leased) return { status: 'checkout-in-progress' };
        await scope.client.query(
          'delete from stripe_checkout_attempts where organization_id = $1 and id = $2 and provider_started_at is null',
          [input.organizationId, open.id],
        );
      }
      const inserted = await scope.client.query(
        `with generated as (select uuidv7() as id)
         insert into stripe_checkout_attempts (id, organization_id, actor_id, key_digest, plan, provider_key)
         select id, $1, $2, $3, $4, 'checkout_' || id::text from generated
         returning id, plan, provider_key, price_id, quantity, success_url, cancel_url, response_url,
           false as provider_started, false as provider_retained, false as replayable,
           false as leased, false as resolved`,
        [input.organizationId, input.actorId, digest, input.plan],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('Checkout reservation was not inserted.');
      return this.claimRow(scope, input.organizationId, checkoutRowSchema.parse(row));
    });
  }

  /** Rechecks entitlement and immutable provider input before every external request. */
  public async saveRequest(
    organizationId: string,
    token: string,
    request: CheckoutProviderRequest,
  ): Promise<boolean> {
    if (
      request.organizationId !== organizationId ||
      !Number.isSafeInteger(request.quantity) ||
      request.quantity < 1
    )
      return false;
    assertNoActiveTransaction();
    return this.runner.run(async (scope) => {
      this.assertTenant(scope, organizationId);
      await lockBillingEntitlement(scope, organizationId, 'shared');
      await this.lockCheckout(scope, organizationId);
      const result = await scope.client.query(
        `update stripe_checkout_attempts
         set price_id = coalesce(price_id, $4), quantity = coalesce(quantity, $5),
             success_url = coalesce(success_url, $6), cancel_url = coalesce(cancel_url, $7),
             provider_started_at = coalesce(provider_started_at, clock_timestamp()),
             updated_at = clock_timestamp(), version = version + 1
         where organization_id = $1 and lease_token = $2 and provider_key = $3
           and lease_expires_at > clock_timestamp() and response_url is null and resolved_at is null
           and not exists (
             select 1 from stripe_bindings where organization_id = $1
           )
           and (provider_started_at is null or (
             provider_started_at > clock_timestamp() - interval '23 hours 55 minutes'
             and price_id = $4 and quantity = $5 and success_url = $6 and cancel_url = $7
           ))
         returning id`,
        [
          organizationId,
          token,
          request.providerKey,
          request.priceId,
          request.quantity,
          request.successUrl,
          request.cancelUrl,
        ],
      );
      return result.rows.length === 1;
    });
  }

  /** Stores the response only for the unexpired lease that issued the request. */
  public async complete(organizationId: string, token: string, url: string): Promise<boolean> {
    assertNoActiveTransaction();
    return this.runner.run(async (scope) => {
      this.assertTenant(scope, organizationId);
      const result = await scope.client.query(
        `update stripe_checkout_attempts
         set response_url = $3, completed_at = now(), lease_token = null, lease_expires_at = null,
             updated_at = now(), version = version + 1
         where organization_id = $1 and lease_token = $2 and lease_expires_at > clock_timestamp()
           and provider_started_at is not null and response_url is null and resolved_at is null
         returning id`,
        [organizationId, token, url],
      );
      return result.rows.length === 1;
    });
  }

  /** Releases the caller's lease without changing a recorded provider request. */
  public async release(organizationId: string, token: string): Promise<void> {
    assertNoActiveTransaction();
    await this.runner.run(async (scope) => {
      this.assertTenant(scope, organizationId);
      await scope.client.query(
        `update stripe_checkout_attempts set lease_token = null, lease_expires_at = null,
           updated_at = now(), version = version + 1
         where organization_id = $1 and lease_token = $2 and lease_expires_at > clock_timestamp() and resolved_at is null`,
        [organizationId, token],
      );
    });
  }

  /** Refuses to use an explicit tenant different from the active transaction context. */
  private assertTenant(scope: TransactionScope<DatabaseSchema>, organizationId: string): void {
    if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
      throw new Error('Checkout organization does not match the tenant scope.');
    }
  }

  /** Serializes checkout reservations and admission checks for one organization. */
  private async lockCheckout(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
  ): Promise<void> {
    await scope.client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `billing.checkout:${organizationId.toLowerCase()}`,
    ]);
  }

  /** Sets a new lease token while preserving any immutable provider parameters. */
  private async claimRow(
    scope: TransactionScope<DatabaseSchema>,
    organizationId: string,
    row: CheckoutRow,
  ): Promise<CheckoutClaim> {
    const token = randomBytes(32).toString('hex');
    const result = await scope.client.query(
      `update stripe_checkout_attempts set lease_token = $3,
         lease_expires_at = clock_timestamp() + interval '2 minutes', updated_at = clock_timestamp(), version = version + 1
       where organization_id = $1 and id = $2 and resolved_at is null
         and (lease_expires_at is null or lease_expires_at <= clock_timestamp()) returning id`,
      [organizationId, row.id, token],
    );
    if (result.rows.length !== 1) return { status: 'request-in-progress' };
    let request: CheckoutProviderRequest | null = null;
    if (row.provider_started) {
      const quantity = Number(row.quantity);
      if (
        !row.price_id ||
        !row.success_url ||
        !row.cancel_url ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1
      ) {
        throw new Error('Stored checkout provider input is invalid.');
      }
      request = {
        organizationId,
        providerKey: row.provider_key,
        priceId: row.price_id,
        quantity,
        successUrl: row.success_url,
        cancelUrl: row.cancel_url,
      };
    }
    return { status: 'claimed', token, providerKey: row.provider_key, request };
  }
  // #endregion
}

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
import type { CheckoutRecoveryTarget } from '../../../../../application/models/checkout/checkout-recovery-target.model.js';
import type { FirstCheckoutDispatch } from '../../../../../application/models/checkout/first-checkout-dispatch.model.js';
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
  provider_expires_at: z.string().transform(Number).pipe(z.number().int().positive()).nullable(),
  replayable: z.boolean().nullable(),
  leased: z.boolean().nullable(),
  resolved: z.boolean(),
});

const recoveryRowSchema = z.object({
  provider_key: z.string(),
  provider_started_at: z.date(),
  provider_session_id: z.string().nullable(),
  price_id: z.string(),
  quantity: z.string().transform(Number).pipe(z.number().int().positive()),
  provider_expires_at: checkoutRowSchema.shape.provider_expires_at,
});
const stripeSessionId = /^cs_[A-Za-z0-9_]{1,252}$/u;
const dispatchRowSchema = z.object({
  first_dispatch: z.boolean(),
  version: z.string().transform(Number).pipe(z.number().int().positive()),
});

type CheckoutRow = z.infer<typeof checkoutRowSchema>;

/** Serializes durable checkout leases without holding a transaction over provider I/O. */
export class DrizzleCheckoutUnitOfWork implements CheckoutUnitOfWork {
  // #region Constructor
  /** Binds provider dispatch to the credential digest and the tenant-scoped runner. */
  public constructor(
    private readonly runner: TenantTransactionRunner<DatabaseSchema>,
    private readonly dispatchKeyDigest: string,
  ) {
    if (!/^[a-f0-9]{64}$/u.test(dispatchKeyDigest)) {
      throw new Error('Checkout dispatch requires a valid credential digest.');
    }
  }
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
           provider_expires_at,
           provider_started_at is not null as provider_started,
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
        if (existing.resolved) return { status: 'unavailable' };
        if (existing.leased) return { status: 'request-in-progress' };
        return this.claimRow(scope, input.organizationId, existing);
      }

      const active = await scope.client.query(
        `select id, plan, provider_key, price_id, quantity, success_url, cancel_url, response_url,
           provider_expires_at,
           provider_started_at is not null as provider_started,
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
           provider_expires_at, false as provider_started, false as replayable,
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
  ): ReturnType<CheckoutUnitOfWork['saveRequest']> {
    const expiresAt = request.expiresAt;
    if (
      request.organizationId !== organizationId ||
      !Number.isSafeInteger(request.quantity) ||
      request.quantity < 1 ||
      expiresAt === undefined ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < 1
    )
      return null;
    assertNoActiveTransaction();
    return this.runner.run(async (scope) => {
      this.assertTenant(scope, organizationId);
      await lockBillingEntitlement(scope, organizationId, 'shared');
      await this.lockCheckout(scope, organizationId);
      const result = await scope.client.query(
        `update stripe_checkout_attempts
         set price_id = coalesce(price_id, $4), quantity = coalesce(quantity, $5),
             success_url = coalesce(success_url, $6), cancel_url = coalesce(cancel_url, $7),
             provider_expires_at = coalesce(provider_expires_at, $8::bigint),
             provider_dispatch_key_digest = coalesce(provider_dispatch_key_digest, $9),
             provider_started_at = coalesce(provider_started_at, clock_timestamp()),
             updated_at = clock_timestamp(), version = version + 1
         where organization_id = $1 and lease_token = $2 and provider_key = $3
           and lease_expires_at > clock_timestamp() and response_url is null and resolved_at is null
           and not exists (
             select 1 from stripe_bindings where organization_id = $1
           )
           and $8::bigint > extract(epoch from clock_timestamp() + interval '31 minutes')
           and ((provider_started_at is null and
             $8::bigint <= extract(epoch from clock_timestamp() + interval '2 hours 5 minutes'))
             or (
             provider_started_at > clock_timestamp() - interval '23 hours 55 minutes'
             and price_id = $4 and quantity = $5 and success_url = $6 and cancel_url = $7
             and provider_expires_at = $8::bigint
             and provider_dispatch_key_digest = $9
           ))
         returning old.provider_started_at is null as first_dispatch, new.version`,
        [
          organizationId,
          token,
          request.providerKey,
          request.priceId,
          request.quantity,
          request.successUrl,
          request.cancelUrl,
          expiresAt,
          this.dispatchKeyDigest,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const dispatch = dispatchRowSchema.parse(row);
      return dispatch.first_dispatch
        ? { status: 'first-dispatch', version: dispatch.version }
        : { status: 'retry' };
    });
  }

  /** Resolves a rejected first dispatch without forgetting its idempotency record. */
  public async resolveRejected(
    organizationId: string,
    token: string,
    providerKey: string,
    dispatch: FirstCheckoutDispatch,
  ): Promise<boolean> {
    assertNoActiveTransaction();
    return this.runner.run(async (scope) => {
      this.assertTenant(scope, organizationId);
      await lockBillingEntitlement(scope, organizationId, 'shared');
      await this.lockCheckout(scope, organizationId);
      const result = await scope.client.query(
        `update stripe_checkout_attempts
         set resolved_at = clock_timestamp(), lease_token = null, lease_expires_at = null,
             updated_at = clock_timestamp(), version = version + 1
         where organization_id = $1 and lease_token = $2 and provider_key = $3
           and version = $4 and provider_dispatch_key_digest = $5
           and lease_expires_at > clock_timestamp()
           and provider_started_at is not null and provider_expires_at is not null
           and response_url is null and provider_session_id is null and resolved_at is null
         returning id`,
        [organizationId, token, providerKey, dispatch.version, this.dispatchKeyDigest],
      );
      return result.rows.length === 1;
    });
  }

  /** Reads only this tenant's unresolved provider request for a read-only recovery check. */
  public async findUnresolved(organizationId: string): Promise<CheckoutRecoveryTarget | null> {
    assertNoActiveTransaction();
    return this.runner.run(
      async (scope) => {
        this.assertTenant(scope, organizationId);
        const result = await scope.client.query(
          `select provider_key, provider_started_at, provider_session_id, price_id, quantity, provider_expires_at
           from stripe_checkout_attempts
           where organization_id = $1 and resolved_at is null and provider_started_at is not null
           limit 1`,
          [organizationId],
        );
        const raw = result.rows[0];
        if (raw === undefined) return null;
        const row = recoveryRowSchema.parse(raw);
        return {
          organizationId,
          providerKey: row.provider_key,
          providerStartedAt: row.provider_started_at,
          sessionId: row.provider_session_id,
          priceId: row.price_id,
          quantity: row.quantity,
          expiresAt: row.provider_expires_at ?? undefined,
        };
      },
      { readOnly: true },
    );
  }

  /** Stores the response only for the unexpired lease that issued the request. */
  public async complete(
    organizationId: string,
    token: string,
    url: string,
    sessionId?: string,
  ): Promise<boolean> {
    if (sessionId !== undefined && !stripeSessionId.test(sessionId)) return false;
    assertNoActiveTransaction();
    return this.runner.run(async (scope) => {
      this.assertTenant(scope, organizationId);
      const result = await scope.client.query(
        `update stripe_checkout_attempts
         set response_url = $3, provider_session_id = coalesce(provider_session_id, $4::text),
             completed_at = now(), lease_token = null, lease_expires_at = null,
             updated_at = now(), version = version + 1
         where organization_id = $1 and lease_token = $2 and lease_expires_at > clock_timestamp()
           and provider_started_at is not null and response_url is null and resolved_at is null
           and (provider_expires_at is null or $4::text is not null)
           and (provider_session_id is null or provider_session_id = $4::text)
         returning id`,
        [organizationId, token, url, sessionId ?? null],
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
        ...(row.provider_expires_at === null ? {} : { expiresAt: row.provider_expires_at }),
      };
    }
    return { status: 'claimed', token, providerKey: row.provider_key, request };
  }
  // #endregion
}

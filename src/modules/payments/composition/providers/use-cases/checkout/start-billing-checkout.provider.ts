import { createHash } from 'node:crypto';

import { CONFIG, InternalHttpClient, InternalTokenSigner } from '@cadenway/nest-common';
import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { GetFreePlan } from '../../../../../plans/public/limits/get-free-plan.js';
import { ReconcileStripeCheckout } from '../../../../application/use-cases/commands/checkout/reconcile-stripe-checkout/reconcile-stripe-checkout.use-case.js';
import { StartBillingCheckout } from '../../../../application/use-cases/commands/checkout/start-billing-checkout/start-billing-checkout.use-case.js';
import { GetBillingEntitlement } from '../../../../application/use-cases/queries/subscriptions/get-billing-entitlement/get-billing-entitlement.use-case.js';
import { createOrganizationCheckoutAuthority } from '../../../../infrastructure/adapters/checkout/organization-checkout-authority.adapter.js';
import { createStripeCheckoutProvider } from '../../../../infrastructure/adapters/stripe/stripe-checkout-provider.adapter.js';
import { DrizzleCheckoutUnitOfWork } from '../../../../infrastructure/persistence/drizzle/transactions/checkout/drizzle-checkout.unit-of-work.js';

/** Enables Checkout only with a configured Team price and the signed Organization authority. */
export const startBillingCheckoutProvider: FactoryProvider<StartBillingCheckout | null> = {
  provide: StartBillingCheckout,
  inject: [
    CONFIG,
    TenantTransactionRunner,
    GetBillingEntitlement,
    GetFreePlan,
    ReconcileStripeCheckout,
  ],
  useFactory: async (
    config: AppConfig,
    runner: TenantTransactionRunner<DatabaseSchema>,
    entitlement: GetBillingEntitlement,
    freePlan: GetFreePlan,
    reconciliation: ReconcileStripeCheckout | null,
  ): Promise<StartBillingCheckout | null> => {
    const {
      BILLING_STRIPE_CHECKOUT_PRICE_ID: priceId,
      BILLING_STRIPE_CHECKOUT_SUCCESS_URL: successUrl,
      BILLING_STRIPE_CHECKOUT_CANCEL_URL: cancelUrl,
      BILLING_STRIPE_API_KEY: key,
      ORGANIZATION_SERVICE_URL: organizationUrl,
      INTERNAL_TOKEN_PRIVATE_JWK: privateJwk,
    } = config;
    if (priceId === undefined) return null;
    if (
      !key ||
      !successUrl ||
      !cancelUrl ||
      !organizationUrl ||
      !privateJwk ||
      reconciliation === null
    ) {
      throw new Error('Stripe Checkout configuration is incomplete.');
    }
    const signer = await InternalTokenSigner.create({ issuer: 'billing-service', privateJwk });
    const client = new InternalHttpClient({
      service: 'organization-service',
      baseUrl: organizationUrl,
      signer,
    });
    return new StartBillingCheckout(
      new DrizzleCheckoutUnitOfWork(runner, createHash('sha256').update(key).digest('hex')),
      createOrganizationCheckoutAuthority(
        client,
        (organizationId) => entitlement.execute({ organizationId }),
        { priceId, successUrl, cancelUrl, freeSeatLimit: freePlan.execute().seats },
      ),
      createStripeCheckoutProvider(key, config.BILLING_STRIPE_WEBHOOK_MODE === 'live'),
      (organizationId, providerKey, sessionId) =>
        reconciliation.recover(organizationId, providerKey, sessionId),
    );
  },
};

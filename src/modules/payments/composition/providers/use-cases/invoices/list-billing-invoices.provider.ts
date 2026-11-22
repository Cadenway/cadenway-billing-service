import { createSecretKey } from 'node:crypto';

import { CONFIG } from '@cadenway/nest-common';
import { TenantTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../../../../../config/app-config.js';
import { ListBillingInvoices } from '../../../../application/use-cases/queries/invoices/list-billing-invoices/list-billing-invoices.use-case.js';
import { createEncryptedInvoiceCursor } from '../../../../infrastructure/adapters/security/encrypted-invoice-cursor.adapter.js';
import { createStripeInvoiceProvider } from '../../../../infrastructure/adapters/stripe/stripe-invoice-provider.adapter.js';
import { DrizzleStripeBindingReader } from '../../../../infrastructure/persistence/drizzle/repositories/subscriptions/drizzle-stripe-binding.repository.js';

/** Binds the invoice query without contacting Stripe during application startup. */
export const listBillingInvoicesProvider: FactoryProvider<ListBillingInvoices> = {
  provide: ListBillingInvoices,
  inject: [TenantTransactionRunner, CONFIG],
  useFactory: (
    tenant: TenantTransactionRunner<DatabaseSchema>,
    config: Readonly<AppConfig>,
  ): ListBillingInvoices => {
    const bindings = new DrizzleStripeBindingReader(tenant);
    const liveMode = config.BILLING_STRIPE_WEBHOOK_MODE === 'live';
    const { BILLING_STRIPE_API_KEY: apiKey, BILLING_STRIPE_INVOICE_CURSOR_KEY: cursorKey } = config;
    if (apiKey === undefined || cursorKey === undefined) {
      return new ListBillingInvoices(bindings, null, null, liveMode);
    }
    return new ListBillingInvoices(
      bindings,
      createStripeInvoiceProvider(apiKey, liveMode),
      createEncryptedInvoiceCursor(createSecretKey(Buffer.from(cursorKey, 'base64url'))),
      liveMode,
    );
  },
};

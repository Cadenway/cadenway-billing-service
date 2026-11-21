import type { IssuedInvoice } from '../../../../models/invoices/issued-invoice.model.js';

/** Reads one bounded page of issued invoices from the configured Stripe account. */
export interface StripeInvoiceProvider {
  // #region Properties
  /** Returns validated, issued invoice data in newest-creation-first order with customer and mode. */
  readonly list: (input: {
    readonly customerId: string;
    readonly liveMode: boolean;
    readonly limit: number;
    readonly after: string | null;
  }) => Promise<{
    readonly invoices: readonly {
      readonly customerId: string;
      readonly liveMode: boolean;
      readonly issued: boolean;
      readonly invoice: IssuedInvoice;
    }[];
    readonly next: string | null;
  }>;
  // #endregion
}

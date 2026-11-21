import type { IssuedInvoice } from '../../../../models/invoices/issued-invoice.model.js';

/** A validated page, an invalid cursor or an unavailable upstream authority. */
export type ListBillingInvoicesOutput =
  | {
      readonly status: 'ok';
      readonly page: {
        readonly items: readonly IssuedInvoice[];
        readonly nextCursor: string | null;
      };
    }
  | { readonly status: 'invalid-cursor' }
  | { readonly status: 'unavailable' };

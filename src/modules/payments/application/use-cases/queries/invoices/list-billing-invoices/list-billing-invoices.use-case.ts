import type { StripeBindingSnapshot } from '../../../../models/subscriptions/stripe-binding-snapshot.model.js';
import type { StripeBindingReader } from '../../../../ports/outbound/persistence/subscriptions/stripe-binding-reader.port.js';
import type { StripeInvoiceProvider } from '../../../../ports/outbound/providers/invoices/stripe-invoice-provider.port.js';
import type { InvoiceCursor } from '../../../../ports/outbound/security/invoices/invoice-cursor.port.js';
import type { ListBillingInvoicesInput } from './list-billing-invoices.input.js';
import type { ListBillingInvoicesOutput } from './list-billing-invoices.output.js';

/** Returns one page of issued invoices for the tenant's current Stripe customer. */
export class ListBillingInvoices {
  // #region Constructor
  /** Binds the tenant-scoped authority and the provider and cursor adapters. */
  public constructor(
    private readonly bindings: StripeBindingReader,
    private readonly provider: StripeInvoiceProvider,
    private readonly cursors: InvoiceCursor,
    private readonly liveMode: boolean,
  ) {}
  // #endregion

  // #region Methods
  /** Reads a page after verifying the cursor and fences the result against a binding change. */
  public async execute(input: ListBillingInvoicesInput): Promise<ListBillingInvoicesOutput> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      return { status: 'unavailable' };
    }
    if (input.cursor !== undefined && (input.cursor.length === 0 || input.cursor.length > 1024)) {
      return { status: 'invalid-cursor' };
    }
    try {
      const snapshot: StripeBindingSnapshot | null = await this.bindings.read(input.organizationId);
      if (snapshot === null) {
        return input.cursor === undefined
          ? { status: 'ok', page: { items: [], nextCursor: null } }
          : { status: 'invalid-cursor' };
      }
      const customerId: string = snapshot.binding.customerId;
      const scope = { organizationId: input.organizationId, customerId, liveMode: this.liveMode };
      const after: string | null =
        input.cursor === undefined
          ? null
          : await this.cursors.open({ ...scope, cursor: input.cursor });
      if (input.cursor !== undefined && (after === null || after.length === 0)) {
        return { status: 'invalid-cursor' };
      }
      const page = await this.provider.list({
        customerId,
        liveMode: this.liveMode,
        limit: input.limit,
        after,
      });
      if (
        page.invoices.length > input.limit ||
        (page.next !== null && (page.next.length === 0 || page.next === after)) ||
        page.invoices.some(
          (entry) =>
            !entry.issued || entry.customerId !== customerId || entry.liveMode !== this.liveMode,
        )
      ) {
        return { status: 'unavailable' };
      }
      const nextCursor: string | null =
        page.next === null ? null : await this.cursors.seal({ ...scope, position: page.next });
      if (nextCursor !== null && (nextCursor.length === 0 || nextCursor.length > 1024)) {
        return { status: 'unavailable' };
      }
      const current: StripeBindingSnapshot | null = await this.bindings.read(input.organizationId);
      if (
        current?.revision !== snapshot.revision ||
        current.binding.customerId !== snapshot.binding.customerId ||
        current.binding.subscriptionId !== snapshot.binding.subscriptionId
      ) {
        return { status: 'unavailable' };
      }
      return {
        status: 'ok',
        page: { items: page.invoices.map((entry) => entry.invoice), nextCursor },
      };
    } catch {
      return { status: 'unavailable' };
    }
  }
  // #endregion
}

import Stripe from 'stripe';
import { z } from 'zod';

import type { StripeInvoiceProvider } from '../../../application/ports/outbound/providers/invoices/stripe-invoice-provider.port.js';

type InvoicePage = Awaited<ReturnType<StripeInvoiceProvider['list']>>;

const requestTimeoutMs = 5_000;
const customerId = z
  .string()
  .max(255)
  .regex(/^cus_[A-Za-z0-9_]+$/u);
const invoiceId = z
  .string()
  .max(255)
  .regex(/^in_[A-Za-z0-9_]+$/u);
const invoiceRequest = z.object({
  customerId,
  liveMode: z.boolean(),
  limit: z.number().int().min(1).max(100),
  after: invoiceId.nullable(),
});

const unixSeconds = z.number().int().nonnegative().max(253_402_300_799);
const list = z.object({
  object: z.literal('list'),
  has_more: z.boolean(),
  data: z.custom<readonly unknown[]>(Array.isArray),
});
const invoiceScope = z.object({
  object: z.literal('invoice'),
  id: invoiceId,
  customer: z.union([
    customerId,
    z.object({
      object: z.literal('customer'),
      id: customerId,
      deleted: z.literal(false).optional(),
      livemode: z.boolean(),
    }),
  ]),
  livemode: z.boolean(),
  created: unixSeconds,
  status: z.string().min(1).nullable(),
});
const issuedDetails = z.object({
  number: z.string().min(1),
  status_transitions: z.object({ finalized_at: unixSeconds }),
  period_start: unixSeconds,
  period_end: unixSeconds,
  total: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[a-zA-Z]{3}$/u),
  invoice_pdf: z
    .url()
    .regex(/^https:\/\//u)
    .refine((pdfUrl) => {
      const url = URL.parse(pdfUrl);
      return url?.username === '' && url.password === '';
    })
    .nullish(),
});

/** Reads a bounded page through the Stripe SDK with the configured account and mode. */
export function createStripeInvoiceProvider(
  apiKey: string,
  liveMode: boolean,
): StripeInvoiceProvider {
  const stripe = new Stripe(apiKey, {
    timeout: requestTimeoutMs,
    maxNetworkRetries: 0,
    telemetry: false,
  });

  return {
    async list(input): Promise<InvoicePage> {
      const request = invoiceRequest.safeParse(input);
      if (!request.success || request.data.liveMode !== liveMode) throw unavailable();
      const { customerId, after, limit } = request.data;

      try {
        const response: unknown = await stripe.invoices.list({
          customer: customerId,
          limit,
          ...(after === null ? {} : { starting_after: after }),
        });
        return readPage(response, request.data);
      } catch {
        // SDK errors may contain request headers and Stripe objects. Keep the failure opaque.
        throw unavailable();
      }
    },
  };
}

function readPage(response: unknown, request: z.infer<typeof invoiceRequest>): InvoicePage {
  const decoded = list.safeParse(response);
  if (!decoded.success || decoded.data.data.length > request.limit) throw unavailable();

  const invoices: InvoicePage['invoices'][number][] = [];
  const seen = new Set(request.after === null ? [] : [request.after]);
  let previousCreation = Number.POSITIVE_INFINITY;
  let lastId: string | null = null;
  for (const raw of decoded.data.data) {
    const scope = invoiceScope.safeParse(raw);
    if (!scope.success) throw unavailable();

    const { customer, livemode, status, id, created } = scope.data;
    const customerMatches =
      typeof customer === 'string'
        ? customer === request.customerId
        : customer.id === request.customerId && customer.livemode === request.liveMode;
    if (
      !customerMatches ||
      livemode !== request.liveMode ||
      seen.has(id) ||
      created > previousCreation
    ) {
      throw unavailable();
    }

    seen.add(id);
    previousCreation = created;
    lastId = id;
    if (status === null || status === 'draft') continue;

    const details = issuedDetails.safeParse(raw);
    if (!details.success || details.data.period_start > details.data.period_end) {
      throw unavailable();
    }
    const invoice = details.data;
    invoices.push({
      customerId: request.customerId,
      liveMode: request.liveMode,
      issued: true,
      invoice: {
        number: invoice.number,
        periodStart: new Date(invoice.period_start * 1_000).toISOString(),
        periodEnd: new Date(invoice.period_end * 1_000).toISOString(),
        totalMinorUnits: invoice.total,
        currency: invoice.currency.toUpperCase(),
        status,
        pdfUrl: invoice.invoice_pdf ?? null,
      },
    });
  }

  if (decoded.data.has_more && lastId === null) throw unavailable();
  // Stripe seeks from the last examined invoice, including a draft excluded from the response.
  return { invoices, next: decoded.data.has_more ? lastId : null };
}

function unavailable(): Error {
  return new Error('Stripe invoice history is unavailable.');
}

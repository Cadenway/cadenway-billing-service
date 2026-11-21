/** A validated issued invoice read from the tenant's payment provider. */
export interface IssuedInvoice {
  // #region Properties
  /** Issued invoice number. */
  readonly number: string;

  /** Invoiced period boundaries as UTC timestamps. */
  readonly periodStart: string;
  readonly periodEnd: string;

  /** Total including taxes and discounts in the currency's smallest unit. */
  readonly totalMinorUnits: number;

  /** ISO currency code in uppercase. */
  readonly currency: string;

  /** Current provider status of the issued invoice. */
  readonly status: string;

  /** Provider-hosted HTTPS PDF URL, when available. */
  readonly pdfUrl: string | null;
  // #endregion
}

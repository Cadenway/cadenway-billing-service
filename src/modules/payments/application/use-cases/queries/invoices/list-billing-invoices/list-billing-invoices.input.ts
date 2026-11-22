/** A bounded invoice request using the organization established by the signed caller. */
export interface ListBillingInvoicesInput {
  // #region Properties
  /** The verified caller's selected organization. */
  readonly organizationId: string;

  /** Number of issued invoices to return, from 1 through 100. */
  readonly limit: number;

  /** Authenticated position returned by the preceding page, if supplied. */
  readonly cursor?: string;
  // #endregion
}

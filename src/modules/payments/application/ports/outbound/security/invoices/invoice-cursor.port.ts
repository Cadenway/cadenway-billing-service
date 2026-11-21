/** Authenticates pagination positions against the verified tenant, customer and Stripe mode. */
export interface InvoiceCursor {
  // #region Properties
  /** Opens a cursor for exactly the supplied binding, or returns null if it is invalid. */
  readonly open: (input: {
    readonly cursor: string;
    readonly organizationId: string;
    readonly customerId: string;
    readonly liveMode: boolean;
  }) => Promise<string | null>;

  /** Seals a provider position for exactly the supplied binding. */
  readonly seal: (input: {
    readonly position: string;
    readonly organizationId: string;
    readonly customerId: string;
    readonly liveMode: boolean;
  }) => Promise<string>;
  // #endregion
}

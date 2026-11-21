/** Scope established by a verified or Billing-owned tenant transaction. */
export interface GetBillingEntitlementInput {
  // #region Properties
  /** Tenant whose committed entitlement is requested. */
  readonly organizationId: string;
  // #endregion
}

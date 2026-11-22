/** Reads one organization's committed plan and the limits used by the usage projection. */
export interface ReadUsagePlan {
  // #region Methods
  /** Returns the plan and both limits from one entitlement snapshot. */
  read(organizationId: string): Promise<{
    readonly plan: 'free' | 'team';
    readonly seatLimit: number;
    readonly storageByteLimit: number;
  }>;
  // #endregion
}

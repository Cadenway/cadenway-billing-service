import { FREE_PLAN_LIMITS } from '../../../../../domain/value-objects/limits/free-plan-limits.value-object.js';

import type { GetFreePlanOutput } from './get-free-plan.output.js';

/** Reads the plan entitlement available to organizations in P5. */
export class GetFreePlan {
  // #region Methods
  /** Returns the immutable limits of the Free plan. */
  public execute(): GetFreePlanOutput {
    return { id: 'free', ...FREE_PLAN_LIMITS };
  }
  // #endregion
}

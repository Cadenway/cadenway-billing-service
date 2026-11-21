/** Source state for a single member or file locator at a positive safe integer version. */
export type UsageObservation<T> =
  | { readonly state: 'present'; readonly version: number; readonly value: T }
  | { readonly state: 'absent'; readonly version: number };

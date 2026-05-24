import type { HealthState } from './redfish-types';

export interface HealthTransition {
  /** True when `next` differs from the previously stored value. */
  changed: boolean;
  /** True when this transition should fire the "critical" trigger. */
  critical: boolean;
}

/**
 * Decide which health flow-triggers a poll should fire.
 *
 * Pure decision-logic extracted from the device poll so it can be unit-tested
 * without a Homey mock:
 *  - `changed` is true whenever the new value differs from the previous one
 *    (including the first reading, where `prev` is null/undefined).
 *  - `critical` fires only on a change to the `'critical'` state, so a server
 *    that stays critical between polls is not re-announced.
 */
export function healthTransition(prev: string | null | undefined, next: HealthState): HealthTransition {
  const changed = prev !== next;
  return { changed, critical: changed && next === 'critical' };
}

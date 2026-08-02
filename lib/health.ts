import type { HealthState } from './redfish-types';

export interface HealthTransition {
  /** True when `next` differs from the previously stored value. */
  changed: boolean;
  /** True when this transition should fire the "warning" trigger. */
  warning: boolean;
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
 *  - `warning` and `critical` fire only on a change into their corresponding
 *    states, so a server that stays degraded between polls is not re-announced.
 */
export function healthTransition(prev: string | null | undefined, next: HealthState): HealthTransition {
  const changed = prev !== next;
  return {
    changed,
    warning: changed && next === 'warning',
    critical: changed && next === 'critical',
  };
}

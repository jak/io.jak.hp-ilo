import type { DeviceResetType } from './redfish-types';

/**
 * Maps each power flow-action card id to the Redfish reset type it performs.
 *
 * Kept Homey-free so the mapping can be unit-tested directly; the driver
 * imports this and registers a run listener per entry. The value type is
 * `DeviceResetType`, so the compiler rejects any reset value the device
 * (and the on/off listener) does not support.
 */
const RESET_BY_CARD: Record<string, DeviceResetType> = {
  turn_on: 'On',
  graceful_shutdown: 'GracefulShutdown',
  force_off: 'ForceOff',
  warm_reset: 'GracefulRestart',
  cold_boot: 'ForceRestart',
};

export default RESET_BY_CARD;

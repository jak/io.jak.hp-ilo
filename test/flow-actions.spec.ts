import { expect } from 'chai';
import RESET_BY_CARD from '../lib/flow-actions';
import type { DeviceResetType } from '../lib/redfish-types';

// The set of reset values the device + on/off listener support. Keep in sync
// with DeviceResetType; the assertions below guard against drift.
const VALID: DeviceResetType[] = ['On', 'ForceOff', 'GracefulShutdown', 'GracefulRestart', 'ForceRestart'];

describe('RESET_BY_CARD flow-action map', () => {
  it('maps all five power cards to the expected reset types', () => {
    expect(RESET_BY_CARD).to.deep.equal({
      turn_on: 'On',
      graceful_shutdown: 'GracefulShutdown',
      force_off: 'ForceOff',
      warm_reset: 'GracefulRestart',
      cold_boot: 'ForceRestart',
    });
  });

  it('has exactly five entries (no stray or missing cards)', () => {
    expect(Object.keys(RESET_BY_CARD)).to.have.length(5);
  });

  it('only maps to valid DeviceResetType values', () => {
    for (const reset of Object.values(RESET_BY_CARD)) {
      expect(VALID).to.include(reset);
    }
  });
});

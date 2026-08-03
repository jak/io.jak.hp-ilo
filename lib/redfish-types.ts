export type HealthState = 'ok' | 'warning' | 'critical' | 'unknown';
export type PowerState = 'on' | 'off' | 'transitioning' | 'unknown';
export type ResetType =
  | 'On' | 'ForceOff' | 'GracefulShutdown'
  | 'ForceRestart' | 'GracefulRestart' | 'Nmi' | 'PushPowerButton';

/** The reset types surfaced as flow actions / the on-off listener (subset of ResetType). */
export type DeviceResetType = Extract<ResetType, 'On' | 'ForceOff' | 'GracefulShutdown' | 'GracefulRestart' | 'ForceRestart'>;

export interface ThermalReading { inletTemp?: number; cpuTemp?: number; maxFanPercent?: number; }

/** Power state and health taken from a single read of the system resource. */
export interface SystemSnapshot { powerState: PowerState; health: HealthState; }

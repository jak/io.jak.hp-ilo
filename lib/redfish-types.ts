export type HealthState = 'ok' | 'warning' | 'critical' | 'unknown';
export type PowerState = 'on' | 'off' | 'transitioning' | 'unknown';
export type ResetType =
  | 'On' | 'ForceOff' | 'GracefulShutdown'
  | 'ForceRestart' | 'GracefulRestart' | 'Nmi' | 'PushPowerButton';

export interface ThermalReading { inletTemp?: number; cpuTemp?: number; maxFanPercent?: number; }

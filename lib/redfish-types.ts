export type HealthState = 'ok' | 'warning' | 'critical' | 'unknown';
export type PowerState = 'on' | 'off' | 'transitioning' | 'unknown';
export type ResetType =
  | 'On' | 'ForceOff' | 'GracefulShutdown'
  | 'ForceRestart' | 'GracefulRestart' | 'Nmi' | 'PushPowerButton';

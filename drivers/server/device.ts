import Homey from 'homey';
import { IloClient } from '../../lib/IloClient';
import type { HealthState } from '../../lib/redfish-types';

interface ServerStore {
  host: string;
  username: string;
  password: string;
}

/** Reset types exposed to flow actions / the on-off listener. */
type DeviceResetType = 'On' | 'ForceOff' | 'GracefulShutdown' | 'GracefulRestart' | 'ForceRestart';

module.exports = class ServerDevice extends Homey.Device {

  private client?: IloClient;
  private pollTimer?: NodeJS.Timeout;

  async onInit() {
    this.buildClient();

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      if (!this.client) throw new Error('Device is not connected');
      await this.client.setPower(value ? 'On' : 'GracefulShutdown');
    });

    await this.setUnavailable('Connecting…').catch(() => undefined);
    await this.poll();
    this.startPolling();
  }

  private buildClient() {
    // Log out any previous session (onSettings rebuild path) so we don't
    // orphan an iLO session. Fire-and-forget: logout() is idempotent and
    // swallows its own errors. buildClient stays synchronous.
    this.client?.logout().catch(() => undefined);

    const store = this.getStore() as ServerStore;
    const allowSelfSigned = this.getSetting('allow_self_signed') as boolean;
    const host = ((this.getSetting('host') as string) || '').trim() || store.host;
    this.client = new IloClient({
      host,
      username: store.username,
      password: store.password,
      allowSelfSigned,
    });
  }

  private startPolling() {
    const seconds = (this.getSetting('poll_interval') as number) ?? 30;
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    this.pollTimer = this.homey.setInterval(() => {
      this.poll().catch((err) => this.error(err));
    }, seconds * 1000);
  }

  private async poll() {
    if (!this.client) return;

    // allSettled so one failing subresource (e.g. a chassis with no /Thermal)
    // doesn't blank the whole device — fulfilled readings still update.
    const [power, watts, thermal, health] = await Promise.allSettled([
      this.client.getPowerState(),
      this.client.getPowerWatts(),
      this.client.getThermal(),
      this.client.getHealth(),
    ]);

    if (power.status === 'fulfilled' && (power.value === 'on' || power.value === 'off')) {
      await this.setCapabilityValue('onoff', power.value === 'on');
    }
    if (watts.status === 'fulfilled' && watts.value !== null) {
      await this.setCapabilityValue('measure_power', watts.value);
    }
    if (thermal.status === 'fulfilled') {
      const t = thermal.value;
      if (t.inletTemp !== undefined) await this.setCapabilityValue('measure_temperature', t.inletTemp);
      if (t.cpuTemp !== undefined) await this.setCapabilityValue('measure_temperature.cpu', t.cpuTemp);
      if (t.maxFanPercent !== undefined) await this.setCapabilityValue('measure_fan_speed', t.maxFanPercent);
    }
    if (health.status === 'fulfilled' && health.value !== 'unknown') {
      // Health-change triggers are wired up in a later task; for now just reflect the value.
      await this.setCapabilityValue('ilo_health', health.value);
    }

    // Availability keys on getPowerState: power state + health both come from
    // getSystem(), so it's the core "is the iLO reachable/authorized" signal.
    // Thermal/watts failures are soft (device stays available).
    if (power.status === 'rejected') {
      const { reason }: PromiseRejectedResult = power;
      const message = reason instanceof Error ? reason.message : String(reason);
      await this.setUnavailable(`iLO unreachable: ${message}`).catch(() => undefined);
    } else {
      await this.setAvailable();
    }
  }

  async onSettings({ changedKeys }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    if (changedKeys.includes('host') || changedKeys.includes('allow_self_signed')) {
      this.buildClient();
    }
    if (
      changedKeys.includes('poll_interval')
      || changedKeys.includes('host')
      || changedKeys.includes('allow_self_signed')
    ) {
      this.startPolling();
    }
    await this.poll();
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    await this.client?.logout().catch(() => undefined);
  }

  async onUninit() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    await this.client?.logout().catch(() => undefined);
  }

  // Public helpers for flow cards (registered in a later task).
  async actionPower(reset: DeviceResetType) {
    if (!this.client) throw new Error('Device is not connected');
    await this.client.setPower(reset);
  }

  getHealthValue(): HealthState {
    return (this.getCapabilityValue('ilo_health') as HealthState) ?? 'unknown';
  }

  isPoweredOn(): boolean {
    return this.getCapabilityValue('onoff') === true;
  }

};

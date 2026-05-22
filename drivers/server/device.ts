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

  private client!: IloClient;
  private pollTimer?: NodeJS.Timeout;

  async onInit() {
    this.buildClient();

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await this.client.setPower(value ? 'On' : 'GracefulShutdown');
    });

    await this.setUnavailable('Connecting…').catch(() => undefined);
    await this.poll();
    this.startPolling();
  }

  private buildClient() {
    const store = this.getStore() as ServerStore;
    const allowSelfSigned = this.getSetting('allow_self_signed') as boolean;
    const host = (this.getSetting('host') as string) || store.host;
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
    try {
      const [power, watts, thermal, health] = await Promise.all([
        this.client.getPowerState(),
        this.client.getPowerWatts(),
        this.client.getThermal(),
        this.client.getHealth(),
      ]);

      if (power === 'on' || power === 'off') {
        await this.setCapabilityValue('onoff', power === 'on');
      }
      if (watts !== null) await this.setCapabilityValue('measure_power', watts);
      if (thermal.inletTemp !== undefined) await this.setCapabilityValue('measure_temperature', thermal.inletTemp);
      if (thermal.cpuTemp !== undefined) await this.setCapabilityValue('measure_temperature.cpu', thermal.cpuTemp);
      if (thermal.maxFanPercent !== undefined) await this.setCapabilityValue('measure_fan_speed', thermal.maxFanPercent);
      // Health-change triggers are wired up in a later task; for now just reflect the value.
      if (health !== 'unknown') await this.setCapabilityValue('ilo_health', health);

      await this.setAvailable();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.setUnavailable(`iLO unreachable: ${message}`).catch(() => undefined);
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
  }

  async onUninit() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
  }

  // Public helpers for flow cards (registered in a later task).
  async actionPower(reset: DeviceResetType) {
    await this.client.setPower(reset);
  }

  getHealthValue(): HealthState {
    return (this.getCapabilityValue('ilo_health') as HealthState) ?? 'unknown';
  }

  isPoweredOn(): boolean {
    return this.getCapabilityValue('onoff') === true;
  }

};

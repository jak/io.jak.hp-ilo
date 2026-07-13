import Homey from 'homey';
import { IloClient } from '../../lib/IloClient';
import { healthTransition } from '../../lib/health';
import type { HealthState, DeviceResetType } from '../../lib/redfish-types';

interface ServerStore {
  host: string;
  username: string;
  password: string;
}

/** The driver's flow-trigger surface. The driver uses `export =` (module.exports),
 * which is awkward to import as a type, so we narrow `this.driver` to this
 * local interface instead of casting through `any`.
 * Structural mirror of ServerDriver's public surface — keep in sync with the class. */
interface IloServerDriver extends Homey.Driver {
  triggerHealthChanged(device: Homey.Device, health: string): void;
  triggerHealthCritical(device: Homey.Device): void;
  triggerPowered(device: Homey.Device, on: boolean): void;
}

module.exports = class ServerDevice extends Homey.Device {

  private client?: IloClient;
  private pollTimer?: NodeJS.Timeout;

  async onInit() {
    // Power state is the custom read-only `powered` sensor, not `onoff`:
    // `onoff` generates built-in Turn on/off/toggle Flow actions that this
    // device does not implement (all power control is via the app's Flow
    // actions). Migrate devices paired before the switch.
    if (this.hasCapability('onoff')) await this.removeCapability('onoff').catch((err) => this.error(err));
    if (!this.hasCapability('powered')) await this.addCapability('powered').catch((err) => this.error(err));

    this.buildClient();

    await this.setUnavailable(this.homey.__('connecting')).catch(() => undefined);
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
      const isOn = power.value === 'on';
      // Fire the powered_on/powered_off triggers only on a real transition:
      // previous === null is the first poll after pairing (no flow should fire).
      const previous = this.getCapabilityValue('powered') as boolean | null;
      await this.setCapabilityValue('powered', isOn);
      if (previous !== null && previous !== isOn) {
        (this.driver as IloServerDriver).triggerPowered(this, isOn);
      }
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
      const previous = this.getCapabilityValue('ilo_health') as HealthState | null;
      const { changed, critical } = healthTransition(previous, health.value);
      if (changed) {
        const driver = this.driver as IloServerDriver;
        driver.triggerHealthChanged(this, health.value);
        if (critical) driver.triggerHealthCritical(this);
      }
      await this.setCapabilityValue('ilo_health', health.value);
    }

    // Availability keys on getPowerState: power state + health both come from
    // getSystem(), so it's the core "is the iLO reachable/authorized" signal.
    // Thermal/watts failures are soft (device stays available).
    if (power.status === 'rejected') {
      const { reason }: PromiseRejectedResult = power;
      const message = reason instanceof Error ? reason.message : String(reason);
      await this.setUnavailable(`${this.homey.__('unreachable')}${message}`).catch(() => undefined);
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
    return this.getCapabilityValue('powered') === true;
  }

};

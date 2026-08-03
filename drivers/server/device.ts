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
  /** Bumped whenever the client is rebuilt (settings change, repair). A poll
   * that started against an older generation discards its results — they
   * describe a connection that no longer exists, and its availability verdict
   * would clobber the fresh client's. */
  private clientGeneration = 0;
  /** Serializes polls: each new poll runs only after the previous finished,
   * so a slow poll (unreachable iLO, 15s timeouts) can never overlap the next
   * scheduled one and pile requests onto a struggling BMC. */
  private pollChain: Promise<void> = Promise.resolve();
  /** Set on delete/uninit so an in-flight poll can't reschedule the timer. */
  private stopped = false;

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
    this.clientGeneration += 1;
  }

  private startPolling() {
    this.scheduleNextPoll();
  }

  /** (Re)arm the one-shot poll timer. Re-arming only after the previous poll
   * completes (see the timer callback) guarantees a full interval of quiet
   * between polls even when a poll takes longer than the interval itself —
   * with setInterval, slow polls against an unreachable iLO would stack up. */
  private scheduleNextPoll() {
    if (this.stopped) return;
    if (this.pollTimer) this.homey.clearTimeout(this.pollTimer);
    const seconds = (this.getSetting('poll_interval') as number) ?? 30;
    this.pollTimer = this.homey.setTimeout(() => {
      this.poll()
        .catch((err) => this.error(err))
        .finally(() => this.scheduleNextPoll());
    }, seconds * 1000);
  }

  private stopPolling() {
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** Run a poll, serialized behind any poll already in flight. Callers that
   * await this (onInit, onSettings, repair) get their own full poll pass —
   * queued, not coalesced, because after a client rebuild the queued poll must
   * run against the NEW client rather than reuse the stale in-flight result. */
  private poll(): Promise<void> {
    const run = this.pollChain.then(() => this.doPoll());
    this.pollChain = run.catch(() => undefined);
    return run;
  }

  private async doPoll() {
    const { client, clientGeneration } = this;
    if (!client || this.stopped) return;

    // allSettled so one failing subresource (e.g. a chassis with no /Thermal)
    // doesn't blank the whole device — fulfilled readings still update.
    const [power, watts, thermal, health] = await Promise.allSettled([
      client.getPowerState(),
      client.getPowerWatts(),
      client.getThermal(),
      client.getHealth(),
    ]);

    // The client was swapped (repair / settings change) while this poll was
    // running: everything above describes the old connection, so apply none
    // of it. In particular a failed poll against dead credentials must not
    // mark the device unavailable after the new client already recovered it.
    if (clientGeneration !== this.clientGeneration || this.stopped) return;

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
    this.stopped = true;
    this.stopPolling();
    await this.client?.logout().catch(() => undefined);
  }

  async onUninit() {
    this.stopped = true;
    this.stopPolling();
    await this.client?.logout().catch(() => undefined);
  }

  /** Called from the driver's repair session after the new credentials have
   * been verified with a probe. Persists them, then rebuilds the client and
   * polls immediately so the device recovers without waiting for the next
   * interval. Note: setSettings() does NOT fire onSettings, so the rebuild
   * and re-poll must happen explicitly here. */
  async repairConnection(data: {
    host: string; username: string; password: string; allowSelfSigned: boolean;
  }): Promise<void> {
    await this.setStoreValue('host', data.host);
    await this.setStoreValue('username', data.username);
    await this.setStoreValue('password', data.password);
    // Keep the user-visible settings in sync with the store (buildClient
    // prefers the settings host when present).
    await this.setSettings({ host: data.host, allow_self_signed: data.allowSelfSigned });
    this.buildClient();
    this.startPolling();
    await this.poll();
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

import Homey from 'homey';
import { IloClient, isCertificateError } from '../../lib/IloClient';
import RESET_BY_CARD from '../../lib/flow-actions';
import type { HealthState, DeviceResetType } from '../../lib/redfish-types';

/** The PairSession type is not exported at the top level of the Homey types,
 * so derive it from the onPair signature instead of casting to `any`. */
type PairSession = Parameters<Homey.Driver['onPair']>[0];

interface PairCreds {
  host: string;
  username: string;
  password: string;
  allowSelfSigned: boolean;
}

/** The public surface of the server device that the flow cards rely on.
 * Homey types `args.device` loosely, so we narrow it to this interface
 * instead of casting through `any`.
 * Structural mirror of ServerDevice's public surface — keep in sync with the class. */
interface IloServerDevice extends Homey.Device {
  actionPower(reset: DeviceResetType): Promise<void>;
  getHealthValue(): HealthState;
  isPoweredOn(): boolean;
}

module.exports = class ServerDriver extends Homey.Driver {

  private healthChanged?: Homey.FlowCardTriggerDevice;

  private healthCritical?: Homey.FlowCardTriggerDevice;

  async onInit() {
    this.log('Server driver initialized');
    this.registerFlowCards();
  }

  async onPair(session: PairSession) {
    let creds: PairCreds | undefined;
    // Cache the identity from the manual_login probe so list_devices can reuse
    // it instead of opening a second iLO session (sessions are scarce).
    let info: Awaited<ReturnType<IloClient['probe']>> | undefined;

    session.setHandler('manual_login', async (data: PairCreds) => {
      // Diagnostic logging proves the handler is reached and which host it
      // tried; the password is intentionally never logged.
      this.log('manual_login received', { host: data.host, username: data.username, allowSelfSigned: data.allowSelfSigned });
      if (!data.host || !data.username) throw new Error(this.homey.__('error.hostUserRequired'));
      const client = new IloClient({
        host: data.host,
        username: data.username,
        password: data.password,
        allowSelfSigned: data.allowSelfSigned,
      });
      try {
        info = await client.probe(); // throws on bad host/creds/TLS
        this.log('manual_login probe ok', { name: info.name, serialNumber: info.serialNumber });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.error('manual_login probe failed:', message);
        // Certificate verification failures get a structured response instead
        // of a thrown error, so the pair view can offer a one-tap
        // "allow self-signed and retry" instead of a dead-end message.
        if (isCertificateError(err)) return { certError: true };
        throw new Error(`${this.homey.__('error.couldNotConnect')}${message}`);
      }
      creds = data;
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!creds) return [];
      // Reuse the identity captured during manual_login; only probe again if it
      // is somehow missing (e.g. unusual pairing navigation) — one login normally.
      if (!info) {
        const client = new IloClient({
          host: creds.host,
          username: creds.username,
          password: creds.password,
          allowSelfSigned: creds.allowSelfSigned,
        });
        info = await client.probe();
      }
      // data.id is immutable and must be unique per driver. Prefer the stable
      // serial number; fall back to the host (unique per device) when the
      // server reports no serial, so two serial-less servers don't collide.
      const id = info.serialNumber && info.serialNumber !== 'unknown'
        ? info.serialNumber
        : creds.host;
      return [{
        name: `${info.name} (${creds.host})`,
        data: { id },
        store: {
          host: creds.host,
          username: creds.username,
          password: creds.password,
        },
        settings: {
          host: creds.host,
          allow_self_signed: creds.allowSelfSigned,
          poll_interval: 30,
        },
      }];
    });
  }

  registerFlowCards() {
    // Conditions
    this.homey.flow.getConditionCard('is_on')
      .registerRunListener(async (args: { device: IloServerDevice }) => args.device.isPoweredOn());
    this.homey.flow.getConditionCard('health_is_ok')
      .registerRunListener(async (args: { device: IloServerDevice }) => args.device.getHealthValue() === 'ok');

    // Actions: card id -> Redfish reset type (see lib/flow-actions.ts)
    for (const [cardId, reset] of Object.entries(RESET_BY_CARD)) {
      this.homey.flow.getActionCard(cardId)
        .registerRunListener(async (args: { device: IloServerDevice }) => {
          await args.device.actionPower(reset);
        });
    }

    // Device triggers (fired from device.ts via the methods below)
    this.healthChanged = this.homey.flow.getDeviceTriggerCard('health_changed');
    this.healthCritical = this.homey.flow.getDeviceTriggerCard('health_critical');
  }

  triggerHealthChanged(device: Homey.Device, health: string): void {
    this.healthChanged?.trigger(device, { health }, {}).catch((err) => this.error(err));
  }

  triggerHealthCritical(device: Homey.Device): void {
    this.healthCritical?.trigger(device, {}, {}).catch((err) => this.error(err));
  }

};

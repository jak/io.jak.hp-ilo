import Homey from 'homey';
import { IloClient } from '../../lib/IloClient';

/** The PairSession type is not exported at the top level of the Homey types,
 * so derive it from the onPair signature instead of casting to `any`. */
type PairSession = Parameters<Homey.Driver['onPair']>[0];

interface PairCreds {
  host: string;
  username: string;
  password: string;
  allowSelfSigned: boolean;
}

module.exports = class ServerDriver extends Homey.Driver {

  async onInit() {
    this.log('Server driver initialized');
    this.registerFlowCards();
  }

  async onPair(session: PairSession) {
    let creds: PairCreds | undefined;

    session.setHandler('manual_login', async (data: PairCreds) => {
      if (!data.host || !data.username) throw new Error('Host and username are required');
      const client = new IloClient({
        host: data.host,
        username: data.username,
        password: data.password,
        allowSelfSigned: data.allowSelfSigned,
      });
      try {
        await client.probe(); // throws on bad host/creds/TLS
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not connect: ${message}`);
      }
      creds = data;
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!creds) return [];
      const client = new IloClient({
        host: creds.host,
        username: creds.username,
        password: creds.password,
        allowSelfSigned: creds.allowSelfSigned,
      });
      const info = await client.probe();
      return [{
        name: `${info.name} (${creds.host})`,
        data: { id: info.serialNumber },
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
    // flow cards registered in a later task
  }

};

import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

/** Logged-in client + transport whose Systems/1 returns the given body. */
async function setup(body: unknown): Promise<{ c: IloClient; t: FakeTransport }> {
  const t = new FakeTransport();
  loggedIn(t);
  t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
  t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  return { c, t };
}

describe('IloClient UID light', () => {
  describe('getSnapshot uidLight mapping', () => {
    it('prefers LocationIndicatorActive over IndicatorLED', async () => {
      const { c } = await setup({ LocationIndicatorActive: false, IndicatorLED: 'Lit' });
      expect((await c.getSnapshot()).uidLight).to.equal(false);
    });

    it('maps IndicatorLED Lit and Blinking to on, Off to off', async () => {
      expect((await (await setup({ IndicatorLED: 'Lit' })).c.getSnapshot()).uidLight).to.equal(true);
      expect((await (await setup({ IndicatorLED: 'Blinking' })).c.getSnapshot()).uidLight).to.equal(true);
      expect((await (await setup({ IndicatorLED: 'Off' })).c.getSnapshot()).uidLight).to.equal(false);
    });

    it('omits uidLight when the server reports neither property (or Unknown)', async () => {
      expect(await (await setup({ PowerState: 'On' })).c.getSnapshot()).to.not.have.property('uidLight');
      expect(await (await setup({ IndicatorLED: 'Unknown' })).c.getSnapshot()).to.not.have.property('uidLight');
    });
  });

  describe('setUidLight', () => {
    it('PATCHes LocationIndicatorActive when the resource exposes it', async () => {
      const { c, t } = await setup({ LocationIndicatorActive: false });
      t.on('PATCH', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: {} });
      await c.setUidLight(true);
      const patch = t.calls.find((x) => x.method === 'PATCH')!;
      expect(JSON.parse(patch.body!)).to.deep.equal({ LocationIndicatorActive: true });
    });

    it('falls back to IndicatorLED Lit/Off on legacy resources', async () => {
      const { c, t } = await setup({ IndicatorLED: 'Off' });
      t.on('PATCH', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: {} });
      await c.setUidLight(true);
      await c.setUidLight(false);
      const patches = t.calls.filter((x) => x.method === 'PATCH').map((x) => JSON.parse(x.body!));
      expect(patches).to.deep.equal([{ IndicatorLED: 'Lit' }, { IndicatorLED: 'Off' }]);
    });

    it('surfaces a Redfish error message when the PATCH is rejected', async () => {
      const { c, t } = await setup({ IndicatorLED: 'Off' });
      t.on('PATCH', '/redfish/v1/Systems/1/', {
        status: 400, headers: {}, body: { error: { '@Message.ExtendedInfo': [{ Message: 'IndicatorLED is read-only on this system.' }] } },
      });
      let err: Error | undefined;
      await c.setUidLight(true).catch((e: Error) => { err = e; });
      expect(err).to.be.instanceOf(Error);
      expect(err!.message).to.equal('IndicatorLED is read-only on this system.');
    });
  });
});

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

describe('IloClient.getSnapshot', () => {
  it('returns power state and health from one GET of the system resource', async () => {
    const { c, t } = await setup({ PowerState: 'On', Status: { HealthRollup: 'OK' } });
    const snap = await c.getSnapshot();
    expect(snap).to.deep.equal({ powerState: 'on', health: 'ok' });
    // One GET for the Systems collection (URI discovery) + ONE for the system
    // resource itself — the whole point of the snapshot.
    const systemGets = t.calls.filter((x) => x.method === 'GET' && x.url.endsWith('/redfish/v1/Systems/1/')).length;
    expect(systemGets).to.equal(1);
  });

  it('maps the same power states as getPowerState (On/Off/Powering*/other)', async () => {
    expect((await (await setup({ PowerState: 'Off' })).c.getSnapshot()).powerState).to.equal('off');
    expect((await (await setup({ PowerState: 'PoweringOn' })).c.getSnapshot()).powerState).to.equal('transitioning');
    expect((await (await setup({ PowerState: 'PoweringOff' })).c.getSnapshot()).powerState).to.equal('transitioning');
    expect((await (await setup({ PowerState: 'Quiescing' })).c.getSnapshot()).powerState).to.equal('unknown');
    expect((await (await setup({})).c.getSnapshot()).powerState).to.equal('unknown');
  });

  it('prefers HealthRollup, falls back to Health, else unknown', async () => {
    expect((await (await setup({ Status: { HealthRollup: 'Warning', Health: 'OK' } })).c.getSnapshot()).health).to.equal('warning');
    expect((await (await setup({ Status: { Health: 'Critical' } })).c.getSnapshot()).health).to.equal('critical');
    expect((await (await setup({ Status: {} })).c.getSnapshot()).health).to.equal('unknown');
    expect((await (await setup({})).c.getSnapshot()).health).to.equal('unknown');
  });

  it('getPowerState/getHealth still work (now delegating to the snapshot)', async () => {
    const { c } = await setup({ PowerState: 'On', Status: { HealthRollup: 'Warning' } });
    expect(await c.getPowerState()).to.equal('on');
    expect(await c.getHealth()).to.equal('warning');
  });

  it('rejects when the system resource errors (reachability signal intact)', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Systems/1/', { status: 500, headers: {}, body: { error: { '@Message.ExtendedInfo': [{ Message: 'internal error' }] } } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    let err: Error | undefined;
    await c.getSnapshot().catch((e: Error) => { err = e; });
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.equal('internal error');
  });
});

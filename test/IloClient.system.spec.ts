import { readFileSync } from 'fs';
import { join } from 'path';
import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

// resolveJsonModule is not enabled in this tsconfig, so load the fixture via fs
// rather than an `import … from './fixtures/system.json'`.
const systemFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'system.json'), 'utf8'));

/** Spin up a logged-in client whose Systems/1 returns the given system body. */
async function clientWithSystem(body: unknown): Promise<IloClient> {
  const t = new FakeTransport();
  loggedIn(t);
  t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
  t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  return c;
}

describe('IloClient system readings', () => {
  it('maps PowerState to on/off/transitioning', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { ...systemFixture, PowerState: 'PoweringOn' } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    expect(await c.getPowerState()).to.equal('transitioning');
  });

  it('maps every PowerState value (On/Off/PoweringOff/unknown)', async () => {
    expect(await (await clientWithSystem({ PowerState: 'On' })).getPowerState()).to.equal('on');
    expect(await (await clientWithSystem({ PowerState: 'Off' })).getPowerState()).to.equal('off');
    expect(await (await clientWithSystem({ PowerState: 'PoweringOff' })).getPowerState()).to.equal('transitioning');
    expect(await (await clientWithSystem({ PowerState: 'Quiescing' })).getPowerState()).to.equal('unknown');
    expect(await (await clientWithSystem({})).getPowerState()).to.equal('unknown');
  });

  it('falls back to Status.Health when HealthRollup is absent', async () => {
    const c = await clientWithSystem({ Status: { Health: 'Critical' } });
    expect(await c.getHealth()).to.equal('critical');
  });

  it('returns unknown health when no status is reported', async () => {
    const c = await clientWithSystem({ Status: {} });
    expect(await c.getHealth()).to.equal('unknown');
    const c2 = await clientWithSystem({});
    expect(await c2.getHealth()).to.equal('unknown');
  });

  it('getServerInfo falls back Model->Name and SerialNumber->Name->unknown', async () => {
    // Model absent -> name & model fall back to Name.
    const noModel = await (await clientWithSystem({ Name: 'Box A', SerialNumber: 'SN1' })).getServerInfo();
    expect(noModel).to.deep.equal({ name: 'Box A', serialNumber: 'SN1', model: 'HPE Server' });
    // Serial absent -> falls back to Name.
    const noSerial = await (await clientWithSystem({ Name: 'Box B' })).getServerInfo();
    expect(noSerial).to.deep.equal({ name: 'Box B', serialNumber: 'Box B', model: 'HPE Server' });
    // Nothing at all -> hard-coded defaults.
    const empty = await (await clientWithSystem({})).getServerInfo();
    expect(empty).to.deep.equal({ name: 'HPE Server', serialNumber: 'unknown', model: 'HPE Server' });
  });

  it('maps HealthRollup (preferred over Health) to a lowercase state', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { Status: { Health: 'OK', HealthRollup: 'Warning' } } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    expect(await c.getHealth()).to.equal('warning');
  });

  it('reads server info (name, serial, model) for pairing', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { Name: 'Computer System', SerialNumber: 'CZ1234', Model: 'ProLiant DL380 Gen10' } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const info = await c.getServerInfo();
    expect(info).to.deep.equal({ name: 'ProLiant DL380 Gen10', serialNumber: 'CZ1234', model: 'ProLiant DL380 Gen10' });
  });
});

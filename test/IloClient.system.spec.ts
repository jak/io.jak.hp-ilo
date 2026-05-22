import { readFileSync } from 'fs';
import { join } from 'path';
import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

// resolveJsonModule is not enabled in this tsconfig, so load the fixture via fs
// rather than an `import … from './fixtures/system.json'`.
const systemFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'system.json'), 'utf8'));

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

import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

describe('IloClient.getPowerWatts', () => {
  it('reads PowerConsumedWatts from the Power resource', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Power', { status: 200, headers: {}, body: { PowerControl: [{ PowerConsumedWatts: 215 }] } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    expect(await c.getPowerWatts()).to.equal(215);
  });

  it('falls back to EnvironmentMetrics.PowerWatts.Reading when Power is 404', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Power', { status: 404, headers: {}, body: {} });
    t.on('GET', '/redfish/v1/Chassis/1/EnvironmentMetrics', { status: 200, headers: {}, body: { PowerWatts: { Reading: 198 } } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    expect(await c.getPowerWatts()).to.equal(198);
  });
});

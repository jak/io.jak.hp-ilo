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

  it('treats a reading of 0 W as a valid value (not a missing reading)', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Power', { status: 200, headers: {}, body: { PowerControl: [{ PowerConsumedWatts: 0 }] } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    expect(await c.getPowerWatts()).to.equal(0);
    // EnvironmentMetrics must NOT be consulted when Power gave a numeric reading.
    const envGets = t.calls.filter((x) => x.url.endsWith('/EnvironmentMetrics')).length;
    expect(envGets).to.equal(0);
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

  it('propagates a non-404 error from the Power resource (does not swallow it)', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Power', {
      status: 500, headers: {}, body: { error: { '@Message.ExtendedInfo': [{ Message: 'sensor subsystem offline' }] } },
    });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    let err: Error | undefined;
    await c.getPowerWatts().catch((e: Error) => { err = e; });
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.equal('sensor subsystem offline');
  });

  it('returns null when neither Power nor EnvironmentMetrics report watts', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Power', { status: 404, headers: {}, body: {} });
    t.on('GET', '/redfish/v1/Chassis/1/EnvironmentMetrics', { status: 404, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    expect(await c.getPowerWatts()).to.equal(null);
  });
});

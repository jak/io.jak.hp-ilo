import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

describe('IloClient member discovery', () => {
  it('discovers and caches system + chassis member URIs', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/enc/' }] } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    expect(await (c as any).systemUri()).to.equal('/redfish/v1/Systems/1/');
    expect(await (c as any).chassisUri()).to.equal('/redfish/v1/Chassis/enc/');
    // second call must be cached (no extra GET on the collection)
    await (c as any).systemUri();
    const collGets = t.calls.filter((x) => x.url.endsWith('/redfish/v1/Systems/')).length;
    expect(collGets).to.equal(1);
  });
});

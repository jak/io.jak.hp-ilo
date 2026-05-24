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

  it('throws when a collection has no members', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [] } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    let err: Error | undefined;
    await (c as any).systemUri().catch((e: Error) => { err = e; });
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.match(/no members/i);
  });

  it('throws when a collection is missing the Members array entirely', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    let err: Error | undefined;
    await (c as any).chassisUri().catch((e: Error) => { err = e; });
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.match(/no members/i);
  });

  it('joins subresources correctly when the chassis URI has no trailing slash', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    // Chassis member URI WITHOUT a trailing slash -> join() must insert one.
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Power', { status: 200, headers: {}, body: { PowerControl: [{ PowerConsumedWatts: 99 }] } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    expect(await c.getPowerWatts()).to.equal(99);
    // The Power GET must be the join of "/redfish/v1/Chassis/1" + "Power" with a single slash.
    expect(t.calls.some((x) => x.url.endsWith('/redfish/v1/Chassis/1/Power'))).to.equal(true);
  });
});

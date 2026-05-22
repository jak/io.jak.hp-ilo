import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

describe('IloClient transient-error retry', () => {
  it('retries a 503 and ultimately returns the 200 body', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    // queued in order: first call 503, second call 200
    t.on('GET', '/redfish/v1/Systems/1/', { status: 503, headers: {}, body: {} });
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { PowerState: 'On' } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn, retryDelayMs: 0 });
    await c.login();
    const body = await (c as any).getJson('/redfish/v1/Systems/1/');
    expect(body.PowerState).to.equal('On');
    // login (1) + 503 (1) + 200 (1)
    const sysGets = t.calls.filter((x) => x.url.endsWith('/redfish/v1/Systems/1/')).length;
    expect(sysGets).to.equal(2);
  });

  it('retries a 429 (rate limited) then succeeds', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/1/', { status: 429, headers: {}, body: {} });
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { PowerState: 'Off' } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn, retryDelayMs: 0 });
    await c.login();
    const body = await (c as any).getJson('/redfish/v1/Systems/1/');
    expect(body.PowerState).to.equal('Off');
  });

  it('bounds retries: a persistent 503 eventually throws (does not loop)', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    // single canned 503 replayed for every call (FakeTransport replays the last when only one is queued)
    t.on('GET', '/redfish/v1/Systems/1/', { status: 503, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn, retryDelayMs: 0 });
    await c.login();
    let err: Error | undefined;
    await (c as any).getJson('/redfish/v1/Systems/1/').catch((e: Error) => { err = e; });
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.match(/503/);
    // initial attempt + 2 bounded retries = 3 GETs on the resource (not infinite)
    const sysGets = t.calls.filter((x) => x.url.endsWith('/redfish/v1/Systems/1/')).length;
    expect(sysGets).to.equal(3);
  });
});

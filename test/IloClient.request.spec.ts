import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

describe('IloClient authenticated requests', () => {
  it('sends X-Auth-Token after login', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { PowerState: 'On' } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const body = await (c as any).getJson('/redfish/v1/Systems/1/');
    expect(body.PowerState).to.equal('On');
    expect(t.calls[1].headers['X-Auth-Token']).to.equal('TOK1');
  });

  it('re-logs-in once and retries on a 401', async () => {
    const t = new FakeTransport();
    loggedIn(t); // first login -> TOK1
    t.on('GET', '/redfish/v1/Systems/1/', { status: 401, headers: {}, body: {} }); // expired
    // second login attempt returns a new token
    t.on('POST', '/redfish/v1/SessionService/Sessions/', {
      status: 201, headers: { 'x-auth-token': 'TOK2', location: '/redfish/v1/SessionService/Sessions/s2/' }, body: {},
    });
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { PowerState: 'Off' } }); // retry ok
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const body = await (c as any).getJson('/redfish/v1/Systems/1/');
    expect(body.PowerState).to.equal('Off');
  });

  it('does not loop on a second consecutive 401 (re-login once, then propagate)', async () => {
    const t = new FakeTransport();
    loggedIn(t); // initial login -> TOK1
    // The resource always answers 401, even after the re-login.
    t.on('GET', '/redfish/v1/Systems/1/', { status: 401, headers: {}, body: {} });
    // The forced re-login succeeds with a fresh token.
    t.on('POST', '/redfish/v1/SessionService/Sessions/', {
      status: 201, headers: { 'x-auth-token': 'TOK2', location: '/redfish/v1/SessionService/Sessions/s2/' }, body: {},
    });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    let err: Error | undefined;
    await (c as any).getJson('/redfish/v1/Systems/1/').catch((e: Error) => { err = e; });
    // The second 401 surfaces as a >=400 friendly error, not an infinite loop.
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.match(/401/);
    // Exactly two GETs on the resource: original attempt + one post-relogin retry.
    const sysGets = t.calls.filter((x) => x.method === 'GET' && x.url.endsWith('/redfish/v1/Systems/1/')).length;
    expect(sysGets).to.equal(2);
    // Exactly two logins: the explicit one plus the single forced re-login.
    const logins = t.calls.filter((x) => x.method === 'POST' && x.url.endsWith('/redfish/v1/SessionService/Sessions/')).length;
    expect(logins).to.equal(2);
  });

  it('getJson throws an Error with .status === 404 on a missing resource', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/1/Missing', { status: 404, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    let err: any;
    await (c as any).getJson('/redfish/v1/Systems/1/Missing').catch((e: any) => { err = e; });
    expect(err).to.be.instanceOf(Error);
    expect(err.status).to.equal(404);
    expect(err.message).to.match(/not found/i);
  });

  it('getJson surfaces a friendly extended-error message on other >=400 responses', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/1/', {
      status: 500,
      headers: {},
      body: { error: { '@Message.ExtendedInfo': [{ Message: 'Internal iLO error' }] } },
    });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    let err: Error | undefined;
    await (c as any).getJson('/redfish/v1/Systems/1/').catch((e: Error) => { err = e; });
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.equal('Internal iLO error');
  });

  it('logout DELETEs the session uri', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('DELETE', '/redfish/v1/SessionService/Sessions/s1/', { status: 200, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    await c.logout();
    expect(t.calls.at(-1)!.method).to.equal('DELETE');
    expect((c as any).authToken).to.equal(undefined);
  });

  it('logout is a no-op (no DELETE) when never logged in', async () => {
    const t = new FakeTransport();
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.logout();
    expect(t.calls.length).to.equal(0);
    expect((c as any).authToken).to.equal(undefined);
    expect((c as any).sessionUri).to.equal(undefined);
  });
});

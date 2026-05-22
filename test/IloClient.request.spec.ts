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
});

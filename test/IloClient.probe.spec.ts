import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

describe('IloClient.probe', () => {
  it('probe returns identity and cleans up the session', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { Model: 'DL380', SerialNumber: 'CZ9' } });
    t.on('DELETE', '/redfish/v1/SessionService/Sessions/s1/', { status: 200, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    const info = await c.probe();
    expect(info.serialNumber).to.equal('CZ9');
    expect(t.calls.at(-1)!.method).to.equal('DELETE'); // logged out
  });

  it('logs out even when the identity read fails (finally)', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    // System collection read fails -> getServerInfo rejects, but the finally
    // block must still DELETE the session so we never orphan it.
    t.on('GET', '/redfish/v1/Systems/', { status: 500, headers: {}, body: { error: { message: 'boom' } } });
    t.on('DELETE', '/redfish/v1/SessionService/Sessions/s1/', { status: 200, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    let err: Error | undefined;
    await c.probe().catch((e: Error) => { err = e; });
    expect(err).to.be.instanceOf(Error);
    expect(t.calls.at(-1)!.method).to.equal('DELETE');
  });
});

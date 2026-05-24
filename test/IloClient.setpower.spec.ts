import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

describe('IloClient.setPower', () => {
  it('POSTs to the discovered reset target with the requested ResetType', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Systems/1/', {
      status: 200,
      headers: {},
      body: {
        Actions: {
          '#ComputerSystem.Reset': {
            'ResetType@Redfish.AllowableValues': ['On', 'ForceOff', 'GracefulShutdown', 'GracefulRestart', 'ForceRestart'],
            target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/',
          },
        },
      },
    });
    t.on('POST', '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/', { status: 200, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    await c.setPower('GracefulShutdown');
    const post = t.calls.find((x) => x.url.endsWith('/Actions/ComputerSystem.Reset/'))!;
    expect(JSON.parse(post.body!)).to.deep.equal({ ResetType: 'GracefulShutdown' });
  });

  it('throws if the firmware does not advertise the requested ResetType', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Systems/1/', {
      status: 200,
      headers: {},
      body: {
        Actions: {
          '#ComputerSystem.Reset': {
            'ResetType@Redfish.AllowableValues': ['On', 'ForceOff', 'ForceRestart'],
            target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/',
          },
        },
      },
    });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    let err: Error | undefined;
    await c.setPower('GracefulShutdown').catch((e) => { err = e; });
    expect(err!.message).to.match(/not supported/i);
  });

  it('throws when the server exposes no reset action', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { Actions: {} } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    let err: Error | undefined;
    await c.setPower('On').catch((e) => { err = e; });
    expect(err!.message).to.match(/does not expose a reset action/i);
  });

  it('POSTs when AllowableValues is absent (no advertised restriction)', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Systems/1/', {
      status: 200,
      headers: {},
      body: { Actions: { '#ComputerSystem.Reset': { target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/' } } },
    });
    t.on('POST', '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/', { status: 204, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    await c.setPower('On');
    const post = t.calls.find((x) => x.url.endsWith('/Actions/ComputerSystem.Reset/'))!;
    expect(JSON.parse(post.body!)).to.deep.equal({ ResetType: 'On' });
  });

  it('surfaces a friendly message when the reset POST fails', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
    t.on('GET', '/redfish/v1/Systems/1/', {
      status: 200,
      headers: {},
      body: {
        Actions: {
          '#ComputerSystem.Reset': {
            'ResetType@Redfish.AllowableValues': ['On', 'ForceOff'],
            target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/',
          },
        },
      },
    });
    t.on('POST', '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/', {
      status: 400,
      headers: {},
      body: { error: { '@Message.ExtendedInfo': [{ Message: 'Already powered on' }] } },
    });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    let err: Error | undefined;
    await c.setPower('On').catch((e) => { err = e; });
    expect(err!.message).to.equal('Already powered on');
  });
});

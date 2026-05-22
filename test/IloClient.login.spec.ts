import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';

describe('IloClient.login', () => {
  it('POSTs credentials to the Sessions endpoint and captures the auth token', async () => {
    const t = new FakeTransport();
    t.on('POST', '/redfish/v1/SessionService/Sessions/', {
      status: 201,
      headers: { 'x-auth-token': 'TOKEN123', location: '/redfish/v1/SessionService/Sessions/abc/' },
      body: {},
    });
    const client = new IloClient({ host: '10.0.0.5', username: 'admin', password: 'secret', transport: t.fn });

    await client.login();

    const req = t.calls[0];
    expect(req.method).to.equal('POST');
    expect(req.url).to.equal('https://10.0.0.5/redfish/v1/SessionService/Sessions/');
    expect(JSON.parse(req.body!)).to.deep.equal({ UserName: 'admin', Password: 'secret' });
    expect(req.headers['Content-Type']).to.equal('application/json');
    expect((client as any).authToken).to.equal('TOKEN123');
    expect((client as any).sessionUri).to.equal('/redfish/v1/SessionService/Sessions/abc/');
  });

  it('throws a clear error on 401 during login', async () => {
    const t = new FakeTransport();
    t.on('POST', '/redfish/v1/SessionService/Sessions/', {
      status: 401,
      headers: {},
      body: { error: { '@Message.ExtendedInfo': [{ MessageId: 'Base.1.0.InvalidCredentials', Message: 'Bad creds' }] } },
    });
    const client = new IloClient({ host: '10.0.0.5', username: 'admin', password: 'wrong', transport: t.fn });

    let err: Error | undefined;
    await client.login().catch((e) => { err = e; });
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.match(/Bad creds|credential/i);
  });
});

import { expect } from 'chai';
import { readFileSync } from 'fs';
import { createServer, Server } from 'https';
import type { AddressInfo, Socket } from 'net';
import { join } from 'path';
import { IloClient, isCertificateError } from '../lib/IloClient';

// End-to-end through the REAL default transport (undici's fetch + Agent)
// against a local HTTPS server with a self-signed certificate — the iLO
// default. Unlike the stubbed transport tests, this exercises the actual
// undici error shapes that isCertificateError / isTimeoutAbort rely on, and
// would have caught the Agent/built-in-fetch mismatch from #36.
// The key pair under fixtures/tls is TEST-ONLY and is never shipped
// (.homeyignore excludes test/).
const TLS_DIR = join(__dirname, 'fixtures', 'tls');

describe('IloClient default transport over real TLS (self-signed)', () => {
  let server: Server;
  let host: string;
  /** When true, the server accepts the request but never answers. */
  let hang = false;
  const sockets = new Set<Socket>();

  before((done) => {
    server = createServer({
      key: readFileSync(join(TLS_DIR, 'test-only-key.pem')),
      cert: readFileSync(join(TLS_DIR, 'test-only-cert.pem')),
    }, (req, res) => {
      if (hang) return;
      if (req.method === 'POST' && req.url === '/redfish/v1/SessionService/Sessions/') {
        res.writeHead(201, {
          'X-Auth-Token': 'TOK',
          Location: '/redfish/v1/SessionService/Sessions/s1/',
          'Content-Type': 'application/json',
        });
        res.end('{}');
        return;
      }
      if (req.url === '/redfish/v1/Systems/1/') {
        const authed = req.headers['x-auth-token'] === 'TOK';
        res.writeHead(authed ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(authed ? { PowerState: 'On' } : {}));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    server.on('connection', (s: Socket) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    server.listen(0, '127.0.0.1', () => {
      host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  after((done) => {
    // close() waits for every open socket: the hung request, undici's
    // keep-alive connections, and TLS sockets the client abandoned during the
    // rejected handshake (which closeAllConnections() doesn't track). Destroy
    // them all so teardown is deterministic.
    sockets.forEach((s) => s.destroy());
    server.close(() => done());
  });

  afterEach(() => { hang = false; });

  it('connects, logs in and reads JSON when allowSelfSigned is on', async () => {
    const c = new IloClient({
      host, username: 'u', password: 'p', allowSelfSigned: true, retryDelayMs: 0,
    });
    await c.login();
    expect((c as any).authToken).to.equal('TOK');
    expect((c as any).sessionUri).to.equal('/redfish/v1/SessionService/Sessions/s1/');
    const sys = await (c as any).getJson('/redfish/v1/Systems/1/');
    expect(sys.PowerState).to.equal('On');
  });

  it('rejects the self-signed certificate by default with the actionable cert error', async () => {
    const c = new IloClient({ host, username: 'u', password: 'p', retryDelayMs: 0 });
    let caught: any;
    await c.login().catch((e: Error) => { caught = e; });
    expect(caught, 'login should reject').to.be.instanceOf(Error);
    expect(caught.certError).to.equal(true);
    expect(caught.message).to.match(/Allow self-signed certificate/);
    // The real undici error is kept as the cause and is itself classifiable.
    expect(isCertificateError(caught.cause)).to.equal(true);
  });

  it('turns a server that never answers into the timeout error', async () => {
    hang = true;
    const c = new IloClient({
      host, username: 'u', password: 'p', allowSelfSigned: true, timeoutMs: 200, retryDelayMs: 0,
    });
    let caught: any;
    await c.login().catch((e: Error) => { caught = e; });
    expect(caught, 'login should reject').to.be.instanceOf(Error);
    expect(caught.message).to.match(/timed out after 0s/i);
  });
});

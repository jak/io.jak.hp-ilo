import { expect } from 'chai';
import { IloClient, createDefaultTransport, isTimeoutAbort } from '../lib/IloClient';
import type { FetchFn } from '../lib/IloClient';

/** A client whose production transport calls `fetchFn` instead of undici's fetch. */
function clientWith(fetchFn: FetchFn, timeoutMs = 15000): IloClient {
  return new IloClient({
    host: 'h', username: 'u', password: 'p', transport: createDefaultTransport(false, timeoutMs, fetchFn),
  });
}

describe('IloClient request timeout', () => {
  it('isTimeoutAbort recognises AbortError/TimeoutError but not other errors', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(isTimeoutAbort(abort)).to.equal(true);
    expect(isTimeoutAbort(timeout)).to.equal(true);
    expect(isTimeoutAbort(new Error('connection refused'))).to.equal(false);
    expect(isTimeoutAbort('not an error')).to.equal(false);
  });

  it('default transport maps a real fetch Response (status + lowercased headers + json)', async () => {
    // Inject a minimal Response-like fetch so the production transport runs
    // its success path: header normalisation + json/text.
    const recorded: any[] = [];
    const headersOf = (entries: Array<[string, string]>) => ({
      // forEach(value, key) — mirrors the Fetch Headers iteration contract.
      forEach(cb: (v: string, k: string) => void) { entries.forEach(([k, v]) => cb(v, k)); },
    });
    const c = clientWith(async (url: string, init: any) => {
      recorded.push({ url, init });
      if (init.method === 'POST') {
        return {
          status: 201,
          headers: headersOf([['X-Auth-Token', 'TOK'], ['Location', '/redfish/v1/SessionService/Sessions/s9/']]),
          json: async () => ({}),
          text: async () => '{}',
        };
      }
      return {
        status: 200,
        headers: headersOf([['Content-Type', 'application/json']]),
        json: async () => ({ PowerState: 'On' }),
        text: async () => '{"PowerState":"On"}',
      };
    });

    await c.login();
    // Header keys are lowercased by the transport, so the token is captured.
    expect((c as any).authToken).to.equal('TOK');
    expect((c as any).sessionUri).to.equal('/redfish/v1/SessionService/Sessions/s9/');
    // A timeout signal is attached to every request.
    expect(recorded[0].init).to.have.property('signal');
    // A GET exercises the response.json() passthrough wired by the transport.
    const sys = await (c as any).getJson('/redfish/v1/Systems/1/');
    expect(sys.PowerState).to.equal('On');
  });

  it('default transport re-throws a non-timeout fetch error unchanged', async () => {
    const connErr = new Error('connect ECONNREFUSED');
    const c = clientWith(async () => { throw connErr; });

    let caught: Error | undefined;
    await c.login().catch((e: Error) => { caught = e; });
    // Not an AbortError -> the original error propagates verbatim (no timeout wrapping).
    expect(caught).to.equal(connErr);
    expect(caught!.message).to.equal('connect ECONNREFUSED');
  });

  it('default transport translates an aborted fetch into a clear timeout error', async () => {
    // Inject a fetch that rejects exactly as AbortSignal.timeout would, so the
    // production transport runs without any real network or real delay.
    const c = clientWith(async () => {
      const err = new Error('This operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    }, 1);

    let caught: Error | undefined;
    await c.probe().catch((e: Error) => { caught = e; });
    expect(caught, 'probe should reject').to.be.instanceOf(Error);
    expect(caught!.message).to.match(/timed out after 0s/i);
  });
});

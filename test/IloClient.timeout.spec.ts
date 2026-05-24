import { expect } from 'chai';
import { IloClient, isTimeoutAbort } from '../lib/IloClient';

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
    // Stub global fetch with a minimal Response-like object so the production
    // defaultTransport runs its success path: header normalisation + json/text.
    const realFetch = (globalThis as any).fetch;
    const recorded: any[] = [];
    const headersOf = (entries: Array<[string, string]>) => ({
      // forEach(value, key) — mirrors the Fetch Headers iteration contract.
      forEach(cb: (v: string, k: string) => void) { entries.forEach(([k, v]) => cb(v, k)); },
    });
    (globalThis as any).fetch = async (url: string, init: any) => {
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
    };
    try {
      const c = new IloClient({ host: 'h', username: 'u', password: 'p' });
      await c.login();
      // Header keys are lowercased by the transport, so the token is captured.
      expect((c as any).authToken).to.equal('TOK');
      expect((c as any).sessionUri).to.equal('/redfish/v1/SessionService/Sessions/s9/');
      // The dispatcher option is passed through (undici-specific) and a signal is attached.
      expect(recorded[0].init).to.have.property('signal');
      // A GET exercises the response.json() passthrough wired by the transport.
      const sys = await (c as any).getJson('/redfish/v1/Systems/1/');
      expect(sys.PowerState).to.equal('On');
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it('default transport re-throws a non-timeout fetch error unchanged', async () => {
    const realFetch = (globalThis as any).fetch;
    const connErr = new Error('connect ECONNREFUSED');
    (globalThis as any).fetch = async () => { throw connErr; };
    try {
      const c = new IloClient({ host: 'h', username: 'u', password: 'p' });
      let caught: Error | undefined;
      await c.login().catch((e: Error) => { caught = e; });
      // Not an AbortError -> the original error propagates verbatim (no timeout wrapping).
      expect(caught).to.equal(connErr);
      expect(caught!.message).to.equal('connect ECONNREFUSED');
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it('throws when no global fetch is available (Node < 18)', async () => {
    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = undefined;
    try {
      // Construction builds the default transport, which probes for global fetch.
      expect(() => new IloClient({ host: 'h', username: 'u', password: 'p' }))
        .to.throw(/Global fetch is unavailable/i);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it('default transport translates an aborted fetch into a clear timeout error', async () => {
    // Stub the global fetch so the default transport runs without any real
    // network or real delay: it rejects exactly as AbortSignal.timeout would.
    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => {
      const err = new Error('This operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    };
    try {
      // No injected transport -> exercises the production defaultTransport path.
      const c = new IloClient({ host: 'h', username: 'u', password: 'p', timeoutMs: 1 });
      let caught: Error | undefined;
      await c.probe().catch((e: Error) => { caught = e; });
      expect(caught, 'probe should reject').to.be.instanceOf(Error);
      expect(caught!.message).to.match(/timed out after 0s/i);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});

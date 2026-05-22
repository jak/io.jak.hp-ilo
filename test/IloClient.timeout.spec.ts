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

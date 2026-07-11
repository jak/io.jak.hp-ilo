import { expect } from 'chai';
import { IloClient, isCertificateError } from '../lib/IloClient';

/** Build the error shape undici's fetch produces for a TLS failure:
 * a generic "fetch failed" TypeError with the real TLS error as `cause`. */
function fetchFailedWith(code: string): Error {
  const tls: any = new Error(`unable to verify: ${code}`);
  tls.code = code;
  const wrapper: any = new TypeError('fetch failed');
  wrapper.cause = tls;
  return wrapper;
}

describe('IloClient certificate errors', () => {
  it('isCertificateError recognises TLS verification codes anywhere in the cause chain', () => {
    expect(isCertificateError(fetchFailedWith('DEPTH_ZERO_SELF_SIGNED_CERT'))).to.equal(true);
    expect(isCertificateError(fetchFailedWith('SELF_SIGNED_CERT_IN_CHAIN'))).to.equal(true);
    expect(isCertificateError(fetchFailedWith('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).to.equal(true);
    expect(isCertificateError(fetchFailedWith('CERT_HAS_EXPIRED'))).to.equal(true);
    // A bare (unwrapped) TLS error is recognised too.
    const bare: any = new Error('self-signed certificate');
    bare.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
    expect(isCertificateError(bare)).to.equal(true);
  });

  it('isCertificateError rejects non-certificate failures', () => {
    expect(isCertificateError(new Error('connect ECONNREFUSED'))).to.equal(false);
    expect(isCertificateError(fetchFailedWith('ECONNRESET'))).to.equal(false);
    expect(isCertificateError(undefined)).to.equal(false);
    expect(isCertificateError('not an error')).to.equal(false);
  });

  it('default transport replaces "fetch failed" with an actionable message and marks it', async () => {
    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => { throw fetchFailedWith('DEPTH_ZERO_SELF_SIGNED_CERT'); };
    try {
      // No injected transport -> exercises the production defaultTransport path.
      const c = new IloClient({ host: 'h', username: 'u', password: 'p' });
      let caught: any;
      await c.probe().catch((e: Error) => { caught = e; });
      expect(caught, 'probe should reject').to.be.instanceOf(Error);
      expect(caught.message).to.match(/self-signed/i);
      expect(caught.message).to.not.equal('fetch failed');
      // The wrapper stays classifiable (flag + original error kept as cause).
      expect(isCertificateError(caught)).to.equal(true);
      expect(caught.cause.message).to.equal('fetch failed');
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});

import { expect } from 'chai';
import { redfishErrorMessage } from '../lib/IloClient';

describe('redfishErrorMessage', () => {
  it('extracts the first @Message.ExtendedInfo Message when present', () => {
    const body = {
      error: {
        '@Message.ExtendedInfo': [
          { Message: 'The session was created.' },
          { Message: 'second entry, ignored' },
        ],
      },
    };
    expect(redfishErrorMessage(body, 'fallback')).to.equal('The session was created.');
  });

  it('falls back to error.message when there is no extended info', () => {
    expect(redfishErrorMessage({ error: { message: 'plain message' } }, 'fallback')).to.equal('plain message');
  });

  it('falls back to error.message when ExtendedInfo[0] has no Message field', () => {
    const body = { error: { '@Message.ExtendedInfo': [{ MessageId: 'Base.1.0.GeneralError' }], message: 'no msg in info' } };
    expect(redfishErrorMessage(body, 'fallback')).to.equal('no msg in info');
  });

  it('uses the provided fallback for an empty/garbage body', () => {
    expect(redfishErrorMessage({}, 'fallback')).to.equal('fallback');
    expect(redfishErrorMessage(undefined, 'fallback')).to.equal('fallback');
    expect(redfishErrorMessage(null, 'fallback')).to.equal('fallback');
    expect(redfishErrorMessage({ error: {} }, 'fallback')).to.equal('fallback');
    expect(redfishErrorMessage({ error: { '@Message.ExtendedInfo': [] } }, 'fallback')).to.equal('fallback');
  });
});

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

  it('skips entries without Message and uses a later entry that has one', () => {
    const body = {
      error: {
        '@Message.ExtendedInfo': [
          { MessageId: 'Base.1.0.GeneralError' },
          { Message: 'the real message' },
        ],
      },
    };
    expect(redfishErrorMessage(body, 'fallback')).to.equal('the real message');
  });

  it('humanizes the MessageId when no entry has a Message (real iLO login-failure shape)', () => {
    const body = {
      error: {
        code: 'iLO.0.10.ExtendedInfo',
        message: 'See @Message.ExtendedInfo for more information.',
        '@Message.ExtendedInfo': [{ MessageId: 'Base.1.0.UnauthorizedLoginAttempt' }],
      },
    };
    expect(redfishErrorMessage(body, 'fallback')).to.equal('Unauthorized login attempt');
  });

  it('prefers a humanized MessageId over the top-level error.message', () => {
    const body = { error: { '@Message.ExtendedInfo': [{ MessageId: 'Base.1.0.GeneralError' }], message: 'no msg in info' } };
    expect(redfishErrorMessage(body, 'fallback')).to.equal('General error');
  });

  it('ignores the "See @Message.ExtendedInfo" boilerplate and uses the fallback', () => {
    const body = { error: { message: 'See @Message.ExtendedInfo for more information.' } };
    expect(redfishErrorMessage(body, 'fallback')).to.equal('fallback');
  });

  it('uses the provided fallback for an empty/garbage body', () => {
    expect(redfishErrorMessage({}, 'fallback')).to.equal('fallback');
    expect(redfishErrorMessage(undefined, 'fallback')).to.equal('fallback');
    expect(redfishErrorMessage(null, 'fallback')).to.equal('fallback');
    expect(redfishErrorMessage({ error: {} }, 'fallback')).to.equal('fallback');
    expect(redfishErrorMessage({ error: { '@Message.ExtendedInfo': [] } }, 'fallback')).to.equal('fallback');
  });
});

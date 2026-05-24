import { expect } from 'chai';
import { healthTransition } from '../lib/health';

describe('healthTransition', () => {
  it('reports no change when the value is unchanged', () => {
    expect(healthTransition('ok', 'ok')).to.deep.equal({ changed: false, critical: false });
    expect(healthTransition('critical', 'critical')).to.deep.equal({ changed: false, critical: false });
  });

  it('reports a change when the value differs (non-critical)', () => {
    expect(healthTransition('ok', 'warning')).to.deep.equal({ changed: true, critical: false });
    expect(healthTransition('warning', 'ok')).to.deep.equal({ changed: true, critical: false });
  });

  it('reports critical only on a change INTO the critical state', () => {
    expect(healthTransition('warning', 'critical')).to.deep.equal({ changed: true, critical: true });
    expect(healthTransition('ok', 'critical')).to.deep.equal({ changed: true, critical: true });
    // Already critical -> no re-announcement.
    expect(healthTransition('critical', 'critical')).to.deep.equal({ changed: false, critical: false });
  });

  it('treats the first reading (prev null/undefined) as a change', () => {
    expect(healthTransition(null, 'ok')).to.deep.equal({ changed: true, critical: false });
    expect(healthTransition(undefined, 'warning')).to.deep.equal({ changed: true, critical: false });
    expect(healthTransition(null, 'critical')).to.deep.equal({ changed: true, critical: true });
  });
});

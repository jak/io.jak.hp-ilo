import { FakeTransport } from './FakeTransport';

/**
 * Queue a successful login response on a FakeTransport so a subsequent
 * client.login() captures token TOK1 and session uri /…/s1/.
 * Reused across the IloClient spec suites.
 */
export function loggedIn(t: FakeTransport): void {
  t.on('POST', '/redfish/v1/SessionService/Sessions/', {
    status: 201,
    headers: { 'x-auth-token': 'TOK1', location: '/redfish/v1/SessionService/Sessions/s1/' },
    body: {},
  });
}

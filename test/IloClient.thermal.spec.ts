import { readFileSync } from 'fs';
import { join } from 'path';
import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

// resolveJsonModule is not enabled in this tsconfig, so load the fixture via fs.
const thermal = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'thermal.json'), 'utf8'));

describe('IloClient.getThermal', () => {
  it('extracts inlet temp, hottest CPU temp, and max fan percent', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Thermal', { status: 200, headers: {}, body: thermal });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const r = await c.getThermal();
    expect(r.inletTemp).to.equal(22);
    expect(r.cpuTemp).to.equal(40);
    expect(r.maxFanPercent).to.equal(11);
  });

  it('returns undefined fields when sensors are missing (never throws)', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Thermal', { status: 200, headers: {}, body: { Temperatures: [], Fans: [] } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const r = await c.getThermal();
    expect(r.inletTemp).to.equal(undefined);
    expect(r.cpuTemp).to.equal(undefined);
    expect(r.maxFanPercent).to.equal(undefined);
  });
});

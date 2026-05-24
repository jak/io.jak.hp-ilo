import { readFileSync } from 'fs';
import { join } from 'path';
import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';
import { loggedIn } from './helpers/loggedIn';

// resolveJsonModule is not enabled in this tsconfig, so load the fixture via fs.
const thermal = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'thermal.json'), 'utf8'));

describe('IloClient.getThermal', () => {
  it('extracts inlet temp, hottest CPU temp (max over multiple CPUs), and max fan percent', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Thermal', { status: 200, headers: {}, body: thermal });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const r = await c.getThermal();
    expect(r.inletTemp).to.equal(22);
    // fixture has two CPU sensors (40 and 38); cpuTemp must be the hottest
    expect(r.cpuTemp).to.equal(40);
    expect(r.maxFanPercent).to.equal(11);
  });

  it('matches the inlet sensor by Name (/inlet ambient/i) when PhysicalContext is not "Intake"', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Thermal', {
      status: 200,
      headers: {},
      body: {
        Temperatures: [
          { Name: '01-Inlet Ambient', PhysicalContext: 'Chassis', ReadingCelsius: 19 },
        ],
        Fans: [],
      },
    });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const r = await c.getThermal();
    expect(r.inletTemp).to.equal(19);
  });

  it('reports the max fan and ignores fans whose ReadingUnits is not "Percent"', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Thermal', {
      status: 200,
      headers: {},
      body: {
        Temperatures: [],
        Fans: [
          { Name: 'Fan 1', Reading: 15, ReadingUnits: 'Percent' },
          { Name: 'Fan 2', Reading: 42, ReadingUnits: 'Percent' },
          { Name: 'Fan 3', Reading: 33, ReadingUnits: 'Percent' },
          // RPM fan must be ignored even though its raw Reading is huge.
          { Name: 'Fan 4', Reading: 9000, ReadingUnits: 'RPM' },
        ],
      },
    });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const r = await c.getThermal();
    expect(r.maxFanPercent).to.equal(42);
  });

  it('returns undefined maxFanPercent when every fan is non-Percent', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Thermal', {
      status: 200,
      headers: {},
      body: { Temperatures: [], Fans: [{ Name: 'Fan 1', Reading: 4200, ReadingUnits: 'RPM' }] },
    });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const r = await c.getThermal();
    expect(r.maxFanPercent).to.equal(undefined);
  });

  it('returns undefined readings (never throws) when the Thermal resource is 404', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
    t.on('GET', '/redfish/v1/Chassis/1/Thermal', { status: 404, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const r = await c.getThermal();
    expect(r).to.deep.equal({ inletTemp: undefined, cpuTemp: undefined, maxFanPercent: undefined });
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

# HP iLO Homey App — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A Homey (Apps SDK v3, TypeScript) app that monitors and controls HPE servers through their iLO 5/6 Redfish API — power on/off, power draw, temperature, fan speed, and health — one Homey device per server.

**Architecture:** A single `server` driver, one device per iLO interface. All Redfish logic lives in a Homey-independent `lib/IloClient.ts` with an injectable HTTP transport so it is unit-testable without a network or the Homey runtime. The `device.ts` polls the client on an interval and maps results onto capabilities; `driver.ts` handles manual-entry pairing and flow-card registration.

**Tech Stack:** Homey Apps SDK v3, TypeScript (`module.exports = class extends Homey.X` scaffold style), Node 24 global `fetch` + `undici.Agent` for TLS control, Mocha + Chai + ts-node for unit tests, Homey CLI 3.12.2 for scaffold/validate/build/run.

---

## Key facts established by research (do not re-derive)

**Homey CLI / scaffold (verified against `athombv/node-homey` source):**
- `homey app create` is interactive, creates a **subfolder named after the app id**, and does **not** run `git init` (only writes `.gitignore`). It installs dev deps only; `homey` is *not* a runtime dependency — types come from the npm alias `@types/homey` → `homey-apps-sdk-v3-types`.
- TS scaffold uses `.ts` files with `import Homey from 'homey'; module.exports = class … extends Homey.X {…}` (NOT `export default` / `.mts`).
- `tsconfig.json` **must** keep `"outDir": ".homeybuild/"` — `homey app run`/`build` hard-fails otherwise.
- No device class for "server/computer" exists → use `class: "other"`. `connectivity: ["lan"]` is valid.
- Sub-capabilities (`measure_temperature.cpu`) are declared by appending `.subid` in `capabilities` and overriding display via `capabilitiesOptions`. No flow cards are auto-generated for them.
- Custom pair views: a `pair/<id>.html` with a global `onHomeyReady(Homey)` entry that **must** call `Homey.ready()`. View→driver via `Homey.emit(event,data)` ↔ `session.setHandler(event, …)`.
- Device returned to `list_devices`: `{ name, data:{id}(immutable), store:{…}(hidden), settings:{…}(user-editable) }`. Secrets go in `store`.
- `homey app run` compiles TS automatically (runs `npm run build` = `tsc`). `homey app validate --level publish|verified` for stricter checks.

**iLO 5/6 Redfish (verified against HPE official docs):**
- Service root `GET /redfish/v1/` is unauthenticated. Discover member URIs from `/redfish/v1/Systems/` and `/redfish/v1/Chassis/` (`Members[0]["@odata.id"]`) — do **not** hard-code `/1`, especially for Chassis.
- Session auth: `POST /redfish/v1/SessionService/Sessions/` body `{UserName,Password}` → `201` with `X-Auth-Token` and `Location` headers. Send `X-Auth-Token` on every request. `DELETE {Location}` to log out. Sessions are scarce → reuse one, clean up, re-login once on `401`.
- Power state: `GET /redfish/v1/Systems/{id}` → `PowerState` ∈ `On|Off|PoweringOn|PoweringOff`.
- Power control: `POST /redfish/v1/Systems/{id}/Actions/ComputerSystem.Reset` body `{ResetType}`. Read allowable values from `Actions["#ComputerSystem.Reset"]["ResetType@Redfish.AllowableValues"]` and the `target`. Map: graceful off=`GracefulShutdown`, hard off=`ForceOff`, warm reset=`GracefulRestart`, cold boot=`ForceRestart`, on=`On`.
- Power watts: try `GET /redfish/v1/Chassis/{id}/Power` → `PowerControl[0].PowerConsumedWatts`; fall back to `…/EnvironmentMetrics` → `PowerWatts.Reading`.
- Thermal: `GET /redfish/v1/Chassis/{id}/Thermal` → `Temperatures[]` (inlet via `PhysicalContext=="Intake"` or Name `"Inlet Ambient"`; CPU via `PhysicalContext=="CPU"`; field `ReadingCelsius`) and `Fans[]` (`Reading` + `ReadingUnits=="Percent"`).
- Health: `GET /redfish/v1/Systems/{id}` → `Status.HealthRollup` (fall back to `Status.Health`) ∈ `OK|Warning|Critical`.
- TLS: iLO is self-signed by default → need `undici.Agent({connect:{rejectUnauthorized:false}})` when allow-self-signed is on.
- Errors: `401` (re-login+retry once), `404` (drive fallbacks), `503`/`429` (back off). Extended error body: `error["@Message.ExtendedInfo"][].{MessageId,Message}`. Always send `Content-Type: application/json` on writes; include `OData-Version: 4.0`.

**Capability set (final):** `onoff`, `measure_power`, `measure_temperature` (inlet), `measure_temperature.cpu`, custom `measure_fan_speed` (number, %), custom `ilo_health` (enum ok/warning/critical).

---

## Task 0: Scaffold the Homey TypeScript app into this directory

**Files:**
- Create: whole scaffold (`app.ts`, `.homeycompose/app.json`, `package.json`, `tsconfig.json`, `.gitignore`, `.eslintrc.json`, `app.json`, `assets/icon.svg`, `locales/en.json`, etc.)

**Why this is fiddly:** `homey app create` is interactive and nests output in a `./io.jak.hp-ilo/` subfolder. We must end up with the app at the repo root (`/Users/jak/Code/io.jak.hp-ilo`), which already exists and contains `docs/`.

**Step 1: Run the CLI in a temp sibling dir, driven by a keystroke stream.**

```bash
cd /Users/jak/Code
rm -rf /tmp/ilo-scaffold && mkdir -p /tmp/ilo-scaffold
cd /tmp/ilo-scaffold
printf 'HP iLO\nManage and monitor HPE servers via the iLO Redfish API\nio.jak.hp-ilo\n\n\n\n\x1b[B\n\n\n\n' | homey app create
```
The `\x1b[B` (down-arrow) selects **TypeScript** at the language prompt; every other prompt takes its default (platform=Homey Pro/local, default category, GPL3 license=yes, github-workflows=no, eslint=yes, confirm=yes). Result: `/tmp/ilo-scaffold/io.jak.hp-ilo/`.

Expected: a populated `io.jak.hp-ilo/` with `app.ts`, `.homeycompose/app.json`, `package.json` (with `"build": "tsc"`), `tsconfig.json` (`outDir: ".homeybuild/"`), `node_modules/`.

**Step 1 (fallback): if the piped CLI run fails** (inquirer needs a TTY), scaffold manually instead. Write these exact files into the repo root and run `homey app add-types` (non-interactive, installs `@types/homey`, `@types/node`, `@tsconfig/node16` and writes `tsconfig.json`):

`package.json`
```json
{
  "name": "io.jak.hp-ilo",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "lint": "eslint --ext .js,.ts --ignore-path .gitignore .",
    "test": "mocha"
  }
}
```
`app.ts`
```typescript
'use strict';

import Homey from 'homey';

module.exports = class IloApp extends Homey.App {
  async onInit() {
    this.log('HP iLO app has been initialized');
  }
};
```
`.homeycompose/app.json`
```json
{
  "id": "io.jak.hp-ilo",
  "version": "1.0.0",
  "compatibility": ">=12.4.0",
  "sdk": 3,
  "runtime": "nodejs",
  "platforms": ["local"],
  "name": { "en": "HP iLO" },
  "description": { "en": "Manage and monitor HPE servers via the iLO Redfish API" },
  "category": ["tools"],
  "permissions": [],
  "images": {
    "small": "/assets/images/small.png",
    "large": "/assets/images/large.png",
    "xlarge": "/assets/images/xlarge.png"
  },
  "author": { "name": "jak", "email": "191585+jak@users.noreply.github.com" }
}
```
`.gitignore` (append to the existing repo `.gitignore` if present): `/env.json`, `/node_modules/`, `/.homeybuild/`.
`.eslintrc.json`: `{ "extends": "athom/homey-app" }`
`locales/en.json`: `{}`
`tsconfig.json` (only if `add-types` wasn't run): `{ "extends": "@tsconfig/node16/tsconfig.json", "compilerOptions": { "allowJs": true, "outDir": ".homeybuild/" } }`

**Step 2: Move the scaffold into the repo root** (only if Step 1 CLI path was used).

```bash
cd /tmp/ilo-scaffold/io.jak.hp-ilo
# move everything except the scaffold's .gitignore (we keep the repo's) into the project root
rsync -a --exclude '.git' ./ /Users/jak/Code/io.jak.hp-ilo/
cd /Users/jak/Code/io.jak.hp-ilo
```
Then edit `.homeycompose/app.json` so `"category": ["tools"]` and the `name`/`description` are as above (the CLI may have stored the literal input — verify).

**Step 3: Add unit-test tooling.**

```bash
cd /Users/jak/Code/io.jak.hp-ilo
npm install --save-dev mocha chai@4 ts-node @types/mocha @types/chai@4
```
Create `.mocharc.json`:
```json
{
  "require": "ts-node/register",
  "spec": "test/**/*.spec.ts"
}
```
Ensure `package.json` has `"test": "mocha"` in scripts (add if missing).

**Step 4: Verify the scaffold is a valid Homey app.**

```bash
homey app validate --level debug
```
Expected: `✓ App validated successfully against level 'debug'`.

**Step 5: Commit.**

```bash
git add -A
git commit -m "Scaffold Homey TypeScript app and test tooling"
```

---

## Task 1: IloClient — HTTP transport abstraction + login (TDD)

**Files:**
- Create: `lib/redfish-types.ts`, `lib/IloClient.ts`
- Test: `test/IloClient.login.spec.ts`

**Step 1: Write the failing test.**

`test/IloClient.login.spec.ts`
```typescript
import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';

describe('IloClient.login', () => {
  it('POSTs credentials to the Sessions endpoint and captures the auth token', async () => {
    const t = new FakeTransport();
    t.on('POST', '/redfish/v1/SessionService/Sessions/', {
      status: 201,
      headers: { 'x-auth-token': 'TOKEN123', location: '/redfish/v1/SessionService/Sessions/abc/' },
      body: {},
    });
    const client = new IloClient({ host: '10.0.0.5', username: 'admin', password: 'secret', transport: t.fn });

    await client.login();

    const req = t.calls[0];
    expect(req.method).to.equal('POST');
    expect(req.url).to.equal('https://10.0.0.5/redfish/v1/SessionService/Sessions/');
    expect(JSON.parse(req.body!)).to.deep.equal({ UserName: 'admin', Password: 'secret' });
    expect(req.headers['Content-Type']).to.equal('application/json');
    expect((client as any).authToken).to.equal('TOKEN123');
    expect((client as any).sessionUri).to.equal('/redfish/v1/SessionService/Sessions/abc/');
  });

  it('throws a clear error on 401 during login', async () => {
    const t = new FakeTransport();
    t.on('POST', '/redfish/v1/SessionService/Sessions/', {
      status: 401,
      headers: {},
      body: { error: { '@Message.ExtendedInfo': [{ MessageId: 'Base.1.0.InvalidCredentials', Message: 'Bad creds' }] } },
    });
    const client = new IloClient({ host: '10.0.0.5', username: 'admin', password: 'wrong', transport: t.fn });

    let err: Error | undefined;
    await client.login().catch((e) => { err = e; });
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.match(/Bad creds|credential/i);
  });
});
```

Also create the test helper `test/helpers/FakeTransport.ts`:
```typescript
import type { HttpRequestFn, HttpResponse } from '../../lib/IloClient';

interface Recorded { method: string; url: string; headers: Record<string, string>; body?: string; }
interface Canned { status: number; headers: Record<string, string>; body: unknown; }

export class FakeTransport {
  public calls: Recorded[] = [];
  private routes = new Map<string, Canned[]>();

  private key(method: string, path: string) { return `${method} ${path}`; }

  // Queue a response for a method+path (path matched by endsWith on the URL path)
  on(method: string, path: string, res: Canned): this {
    const k = this.key(method, path);
    const q = this.routes.get(k) ?? [];
    q.push(res);
    this.routes.set(k, q);
    return this;
  }

  fn: HttpRequestFn = async (url, init) => {
    this.calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    const path = new URL(url).pathname;
    const k = this.key(init.method, path);
    const q = this.routes.get(k);
    if (!q || q.length === 0) throw new Error(`No canned response for ${k}`);
    const canned = q.length > 1 ? q.shift()! : q[0];
    const res: HttpResponse = {
      status: canned.status,
      headers: canned.headers,
      json: async () => canned.body,
      text: async () => JSON.stringify(canned.body),
    };
    return res;
  };
}
```

**Step 2: Run to verify it fails.**

```bash
npm test
```
Expected: FAIL — `Cannot find module '../lib/IloClient'`.

**Step 3: Implement the minimal code.**

`lib/IloClient.ts`
```typescript
import { Agent } from 'undici';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json: () => Promise<any>;
  text: () => Promise<string>;
}

export type HttpRequestFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export interface IloClientOptions {
  host: string;
  username: string;
  password: string;
  allowSelfSigned?: boolean;
  /** Injectable transport for testing; defaults to fetch + undici Agent. */
  transport?: HttpRequestFn;
}

function defaultTransport(allowSelfSigned: boolean): HttpRequestFn {
  const dispatcher = allowSelfSigned
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;
  return async (url, init) => {
    const res = await fetch(url, { ...init, dispatcher } as any);
    const headers: Record<string, string> = {};
    res.headers.forEach((v: string, k: string) => { headers[k.toLowerCase()] = v; });
    return {
      status: res.status,
      headers,
      json: () => res.json(),
      text: () => res.text(),
    };
  };
}

/** Pull a human-readable message out of a Redfish extended-error body. */
export function redfishErrorMessage(body: any, fallback: string): string {
  const info = body?.error?.['@Message.ExtendedInfo'];
  if (Array.isArray(info) && info[0]?.Message) return info[0].Message as string;
  if (body?.error?.message) return body.error.message as string;
  return fallback;
}

export class IloClient {
  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  private readonly transport: HttpRequestFn;
  private authToken?: string;
  private sessionUri?: string;

  constructor(opts: IloClientOptions) {
    this.host = opts.host;
    this.username = opts.username;
    this.password = opts.password;
    this.transport = opts.transport ?? defaultTransport(opts.allowSelfSigned ?? true);
  }

  private url(path: string): string {
    return `https://${this.host}${path}`;
  }

  async login(): Promise<void> {
    const res = await this.transport(this.url('/redfish/v1/SessionService/Sessions/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'OData-Version': '4.0' },
      body: JSON.stringify({ UserName: this.username, Password: this.password }),
    });
    if (res.status !== 201) {
      const body = await res.json().catch(() => ({}));
      throw new Error(redfishErrorMessage(body, `Login failed (HTTP ${res.status})`));
    }
    this.authToken = res.headers['x-auth-token'];
    this.sessionUri = res.headers['location'];
    if (!this.authToken) throw new Error('Login succeeded but no X-Auth-Token was returned');
  }
}
```

`lib/redfish-types.ts` (start it; extended in later tasks)
```typescript
export type HealthState = 'ok' | 'warning' | 'critical' | 'unknown';
export type PowerState = 'on' | 'off' | 'transitioning' | 'unknown';
export type ResetType =
  | 'On' | 'ForceOff' | 'GracefulShutdown'
  | 'ForceRestart' | 'GracefulRestart' | 'Nmi' | 'PushPowerButton';
```

**Step 4: Run to verify it passes.**

```bash
npm test
```
Expected: PASS (2 passing).

**Step 5: Commit.**

```bash
git add lib/ test/
git commit -m "feat(ilo): IloClient transport + session login"
```

---

## Task 2: Authenticated request helper with 401 re-login + logout (TDD)

**Files:**
- Modify: `lib/IloClient.ts`
- Test: `test/IloClient.request.spec.ts`

**Step 1: Write the failing test.**

```typescript
import { expect } from 'chai';
import { IloClient } from '../lib/IloClient';
import { FakeTransport } from './helpers/FakeTransport';

function loggedIn(t: FakeTransport) {
  t.on('POST', '/redfish/v1/SessionService/Sessions/', {
    status: 201, headers: { 'x-auth-token': 'TOK1', location: '/redfish/v1/SessionService/Sessions/s1/' }, body: {},
  });
}

describe('IloClient authenticated requests', () => {
  it('sends X-Auth-Token after login', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { PowerState: 'On' } });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const body = await (c as any).getJson('/redfish/v1/Systems/1/');
    expect(body.PowerState).to.equal('On');
    expect(t.calls[1].headers['X-Auth-Token']).to.equal('TOK1');
  });

  it('re-logs-in once and retries on a 401', async () => {
    const t = new FakeTransport();
    loggedIn(t);                                    // first login -> TOK1
    t.on('GET', '/redfish/v1/Systems/1/', { status: 401, headers: {}, body: {} }); // expired
    // second login attempt returns a new token
    t.on('POST', '/redfish/v1/SessionService/Sessions/', {
      status: 201, headers: { 'x-auth-token': 'TOK2', location: '/redfish/v1/SessionService/Sessions/s2/' }, body: {},
    });
    t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { PowerState: 'Off' } }); // retry ok
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    const body = await (c as any).getJson('/redfish/v1/Systems/1/');
    expect(body.PowerState).to.equal('Off');
  });

  it('logout DELETEs the session uri', async () => {
    const t = new FakeTransport();
    loggedIn(t);
    t.on('DELETE', '/redfish/v1/SessionService/Sessions/s1/', { status: 200, headers: {}, body: {} });
    const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
    await c.login();
    await c.logout();
    expect(t.calls.at(-1)!.method).to.equal('DELETE');
    expect((c as any).authToken).to.equal(undefined);
  });
});
```

**Step 2: Run to verify it fails.** `npm test` → FAIL (`getJson is not a function`).

**Step 3: Implement.** Add to `IloClient`:
```typescript
  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', 'OData-Version': '4.0' };
    if (this.authToken) h['X-Auth-Token'] = this.authToken;
    return h;
  }

  private async request(method: string, path: string, body?: unknown, _retry = true): Promise<HttpResponse> {
    if (!this.authToken) await this.login();
    const res = await this.transport(this.url(path), {
      method,
      headers: this.authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && _retry) {
      this.authToken = undefined;
      await this.login();
      return this.request(method, path, body, false);
    }
    return res;
  }

  async getJson(path: string): Promise<any> {
    const res = await this.request('GET', path);
    if (res.status === 404) { const e: any = new Error(`Not found: ${path}`); e.status = 404; throw e; }
    if (res.status >= 400) {
      const b = await res.json().catch(() => ({}));
      throw new Error(redfishErrorMessage(b, `GET ${path} failed (HTTP ${res.status})`));
    }
    return res.json();
  }

  async logout(): Promise<void> {
    if (this.authToken && this.sessionUri) {
      await this.transport(this.url(this.sessionUri), { method: 'DELETE', headers: this.authHeaders() })
        .catch(() => undefined);
    }
    this.authToken = undefined;
    this.sessionUri = undefined;
  }
```

**Step 4: Run to verify it passes.** `npm test` → PASS.

**Step 5: Commit.** `git commit -am "feat(ilo): authenticated request helper with 401 re-auth and logout"`

---

## Task 3: Member discovery for Systems and Chassis (TDD)

**Files:** Modify `lib/IloClient.ts`; Test `test/IloClient.discovery.spec.ts`

**Step 1: Failing test.**
```typescript
it('discovers and caches system + chassis member URIs', async () => {
  const t = new FakeTransport();
  loggedIn(t);
  t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
  t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/enc/' }] } });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  expect(await (c as any).systemUri()).to.equal('/redfish/v1/Systems/1/');
  expect(await (c as any).chassisUri()).to.equal('/redfish/v1/Chassis/enc/');
  // second call must be cached (no extra GET on the collection)
  await (c as any).systemUri();
  const collGets = t.calls.filter((x) => x.url.endsWith('/redfish/v1/Systems/')).length;
  expect(collGets).to.equal(1);
});
```
(Reuse the `loggedIn` helper; either import it from a shared file or duplicate it locally.)

**Step 2: Verify fails.**

**Step 3: Implement.**
```typescript
  private _systemUri?: string;
  private _chassisUri?: string;

  private async firstMember(collectionPath: string): Promise<string> {
    const coll = await this.getJson(collectionPath);
    const members = coll?.Members;
    if (!Array.isArray(members) || members.length === 0) throw new Error(`No members in ${collectionPath}`);
    return members[0]['@odata.id'];
  }

  async systemUri(): Promise<string> {
    if (!this._systemUri) this._systemUri = await this.firstMember('/redfish/v1/Systems/');
    return this._systemUri;
  }

  async chassisUri(): Promise<string> {
    if (!this._chassisUri) this._chassisUri = await this.firstMember('/redfish/v1/Chassis/');
    return this._chassisUri;
  }
```

**Step 4: Verify passes. Step 5: Commit** `feat(ilo): discover Systems/Chassis member URIs`.

---

## Task 4: getPowerState + getServerInfo + getHealth (TDD)

**Files:** Modify `lib/IloClient.ts`, `lib/redfish-types.ts`; Test `test/IloClient.system.spec.ts`

**Step 1: Failing test** (one fixture reused). Put a representative system response in `test/fixtures/system.json` and load it.
```typescript
import systemFixture from './fixtures/system.json';

it('maps PowerState to on/off/transitioning', async () => {
  const t = new FakeTransport(); loggedIn(t);
  t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
  t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { ...systemFixture, PowerState: 'PoweringOn' } });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  expect(await c.getPowerState()).to.equal('transitioning');
});

it('maps HealthRollup (preferred over Health) to a lowercase state', async () => {
  const t = new FakeTransport(); loggedIn(t);
  t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
  t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { Status: { Health: 'OK', HealthRollup: 'Warning' } } });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  expect(await c.getHealth()).to.equal('warning');
});

it('reads server info (name, serial, model) for pairing', async () => {
  const t = new FakeTransport(); loggedIn(t);
  t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
  t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { Name: 'Computer System', SerialNumber: 'CZ1234', Model: 'ProLiant DL380 Gen10' } });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  const info = await c.getServerInfo();
  expect(info).to.deep.equal({ name: 'ProLiant DL380 Gen10', serialNumber: 'CZ1234', model: 'ProLiant DL380 Gen10' });
});
```
`test/fixtures/system.json` — a trimmed real-shaped response (PowerState On, Status OK, Actions with ResetType allowable values, SerialNumber, Model). (Set `"resolveJsonModule": true` and `"esModuleInterop": true` are inherited from `@tsconfig/node16`; if importing JSON errors, read the file with `fs` instead.)

**Step 3: Implement.**
```typescript
import type { HealthState, PowerState, ResetType } from './redfish-types';

  private mapHealth(raw?: string): HealthState {
    switch ((raw ?? '').toLowerCase()) {
      case 'ok': return 'ok';
      case 'warning': return 'warning';
      case 'critical': return 'critical';
      default: return 'unknown';
    }
  }

  async getSystem(): Promise<any> {
    return this.getJson(await this.systemUri());
  }

  async getPowerState(): Promise<PowerState> {
    const sys = await this.getSystem();
    switch (sys.PowerState) {
      case 'On': return 'on';
      case 'Off': return 'off';
      case 'PoweringOn':
      case 'PoweringOff': return 'transitioning';
      default: return 'unknown';
    }
  }

  async getHealth(): Promise<HealthState> {
    const sys = await this.getSystem();
    return this.mapHealth(sys?.Status?.HealthRollup ?? sys?.Status?.Health);
  }

  async getServerInfo(): Promise<{ name: string; serialNumber: string; model: string }> {
    const sys = await this.getSystem();
    return {
      name: sys.Model || sys.Name || 'HPE Server',
      serialNumber: String(sys.SerialNumber || sys.Name || 'unknown'),
      model: sys.Model || 'HPE Server',
    };
  }
```

**Step 4/5:** verify, commit `feat(ilo): power state, health, and server info`.

---

## Task 5: setPower with runtime AllowableValues validation (TDD)

**Files:** Modify `lib/IloClient.ts`; Test `test/IloClient.setpower.spec.ts`

**Step 1: Failing test.**
```typescript
it('POSTs to the discovered reset target with the requested ResetType', async () => {
  const t = new FakeTransport(); loggedIn(t);
  t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
  t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: {
    Actions: { '#ComputerSystem.Reset': {
      'ResetType@Redfish.AllowableValues': ['On', 'ForceOff', 'GracefulShutdown', 'GracefulRestart', 'ForceRestart'],
      target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/' } } } });
  t.on('POST', '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/', { status: 200, headers: {}, body: {} });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  await c.setPower('GracefulShutdown');
  const post = t.calls.find((x) => x.url.endsWith('/Actions/ComputerSystem.Reset/'))!;
  expect(JSON.parse(post.body!)).to.deep.equal({ ResetType: 'GracefulShutdown' });
});

it('throws if the firmware does not advertise the requested ResetType', async () => {
  const t = new FakeTransport(); loggedIn(t);
  t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
  t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: {
    Actions: { '#ComputerSystem.Reset': {
      'ResetType@Redfish.AllowableValues': ['On', 'ForceOff', 'ForceRestart'],
      target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/' } } } });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  let err: Error | undefined;
  await c.setPower('GracefulShutdown').catch((e) => { err = e; });
  expect(err!.message).to.match(/not supported/i);
});
```

**Step 3: Implement.**
```typescript
  private async resetAction(): Promise<{ target: string; allowable: string[] }> {
    const sys = await this.getSystem();
    const action = sys?.Actions?.['#ComputerSystem.Reset'];
    if (!action?.target) throw new Error('Server does not expose a reset action');
    return { target: action.target, allowable: action['ResetType@Redfish.AllowableValues'] ?? [] };
  }

  async setPower(resetType: ResetType): Promise<void> {
    const { target, allowable } = await this.resetAction();
    if (allowable.length && !allowable.includes(resetType)) {
      throw new Error(`Reset type "${resetType}" is not supported by this server (supports: ${allowable.join(', ')})`);
    }
    const res = await this.request('POST', target, { ResetType: resetType });
    if (res.status >= 400) {
      const b = await res.json().catch(() => ({}));
      throw new Error(redfishErrorMessage(b, `Reset ${resetType} failed (HTTP ${res.status})`));
    }
  }
```

**Step 4/5:** verify, commit `feat(ilo): power control with allowable-value validation`.

---

## Task 6: getPowerWatts with EnvironmentMetrics fallback (TDD)

**Files:** Modify `lib/IloClient.ts`; Test `test/IloClient.power.spec.ts`

**Step 1: Failing test** (happy path via `/Power`, plus fallback when `/Power` 404s).
```typescript
it('reads PowerConsumedWatts from the Power resource', async () => {
  const t = new FakeTransport(); loggedIn(t);
  t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
  t.on('GET', '/redfish/v1/Chassis/1/Power', { status: 200, headers: {}, body: { PowerControl: [{ PowerConsumedWatts: 215 }] } });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  expect(await c.getPowerWatts()).to.equal(215);
});

it('falls back to EnvironmentMetrics.PowerWatts.Reading when Power is 404', async () => {
  const t = new FakeTransport(); loggedIn(t);
  t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
  t.on('GET', '/redfish/v1/Chassis/1/Power', { status: 404, headers: {}, body: {} });
  t.on('GET', '/redfish/v1/Chassis/1/EnvironmentMetrics', { status: 200, headers: {}, body: { PowerWatts: { Reading: 198 } } });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  expect(await c.getPowerWatts()).to.equal(198);
});
```
Note the chassis member URI ends with `/`; build sub-paths as `${chassisUri}Power` carefully (the fixture uses `/redfish/v1/Chassis/1/` so `${uri}Power` → `/redfish/v1/Chassis/1/Power`). Implement a small `join` helper to normalize the single slash.

**Step 3: Implement.**
```typescript
  private join(base: string, sub: string): string {
    return base.endsWith('/') ? base + sub : `${base}/${sub}`;
  }

  /** GET that returns null on 404 instead of throwing. */
  private async getJsonOrNull(path: string): Promise<any | null> {
    try { return await this.getJson(path); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  async getPowerWatts(): Promise<number | null> {
    const chassis = await this.chassisUri();
    const power = await this.getJsonOrNull(this.join(chassis, 'Power'));
    const watts = power?.PowerControl?.[0]?.PowerConsumedWatts;
    if (typeof watts === 'number') return watts;
    const env = await this.getJsonOrNull(this.join(chassis, 'EnvironmentMetrics'));
    const reading = env?.PowerWatts?.Reading;
    return typeof reading === 'number' ? reading : null;
  }
```

**Step 4/5:** verify, commit `feat(ilo): power consumption with EnvironmentMetrics fallback`.

---

## Task 7: getThermal — inlet temp, CPU temp, max fan % (TDD)

**Files:** Modify `lib/IloClient.ts`, `lib/redfish-types.ts`; Test `test/IloClient.thermal.spec.ts` with `test/fixtures/thermal.json`

**Step 1: Failing test.** `test/fixtures/thermal.json` = the trimmed Thermal response from research (inlet `PhysicalContext: "Intake"`, a CPU sensor `PhysicalContext: "CPU"`, several fans with `ReadingUnits: "Percent"`).
```typescript
import thermal from './fixtures/thermal.json';

it('extracts inlet temp, hottest CPU temp, and max fan percent', async () => {
  const t = new FakeTransport(); loggedIn(t);
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
  const t = new FakeTransport(); loggedIn(t);
  t.on('GET', '/redfish/v1/Chassis/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Chassis/1/' }] } });
  t.on('GET', '/redfish/v1/Chassis/1/Thermal', { status: 200, headers: {}, body: { Temperatures: [], Fans: [] } });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  await c.login();
  const r = await c.getThermal();
  expect(r.inletTemp).to.equal(undefined);
  expect(r.cpuTemp).to.equal(undefined);
  expect(r.maxFanPercent).to.equal(undefined);
});
```

**Step 3: Implement.** Add `ThermalReading` to `redfish-types.ts`:
```typescript
export interface ThermalReading { inletTemp?: number; cpuTemp?: number; maxFanPercent?: number; }
```
In `IloClient`:
```typescript
  async getThermal(): Promise<ThermalReading> {
    const chassis = await this.chassisUri();
    const thermal = await this.getJsonOrNull(this.join(chassis, 'Thermal'));
    const temps: any[] = thermal?.Temperatures ?? [];
    const fans: any[] = thermal?.Fans ?? [];

    const isReading = (v: any) => typeof v?.ReadingCelsius === 'number';
    const inlet = temps.find((x) => x.PhysicalContext === 'Intake' || /inlet ambient/i.test(x.Name ?? ''));
    const cpus = temps.filter((x) => x.PhysicalContext === 'CPU' && isReading(x));

    const fanReadings = fans
      .filter((f) => f.ReadingUnits === 'Percent' && typeof f.Reading === 'number')
      .map((f) => f.Reading as number);

    return {
      inletTemp: isReading(inlet) ? inlet.ReadingCelsius : undefined,
      cpuTemp: cpus.length ? Math.max(...cpus.map((x) => x.ReadingCelsius)) : undefined,
      maxFanPercent: fanReadings.length ? Math.max(...fanReadings) : undefined,
    };
  }
```

**Step 4/5:** verify, commit `feat(ilo): thermal readings (inlet/cpu temp, fan %)`.

---

## Task 8: probe() helper for pairing validation (TDD)

**Files:** Modify `lib/IloClient.ts`; Test `test/IloClient.probe.spec.ts`

A single high-level call the pairing flow uses: log in, read server info, log out, return identity. Surface a friendly error on failure.

**Step 1: Failing test.**
```typescript
it('probe returns identity and cleans up the session', async () => {
  const t = new FakeTransport(); loggedIn(t);
  t.on('GET', '/redfish/v1/Systems/', { status: 200, headers: {}, body: { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] } });
  t.on('GET', '/redfish/v1/Systems/1/', { status: 200, headers: {}, body: { Model: 'DL380', SerialNumber: 'CZ9' } });
  t.on('DELETE', '/redfish/v1/SessionService/Sessions/s1/', { status: 200, headers: {}, body: {} });
  const c = new IloClient({ host: 'h', username: 'u', password: 'p', transport: t.fn });
  const info = await c.probe();
  expect(info.serialNumber).to.equal('CZ9');
  expect(t.calls.at(-1)!.method).to.equal('DELETE'); // logged out
});
```

**Step 3: Implement.**
```typescript
  async probe(): Promise<{ name: string; serialNumber: string; model: string }> {
    try {
      await this.login();
      return await this.getServerInfo();
    } finally {
      await this.logout().catch(() => undefined);
    }
  }
```

**Step 4/5:** verify, commit `feat(ilo): probe() for pairing validation`. Then run the **whole** suite: `npm test` → all green; `npm run build` (`tsc`) → no type errors.

---

## Task 9: Custom capabilities + driver.compose.json

**Files:**
- Create: `.homeycompose/capabilities/measure_fan_speed.json`, `.homeycompose/capabilities/ilo_health.json`
- Create: `drivers/server/driver.compose.json`
- Create: placeholder driver assets (see Step 3)

**Step 1: Custom capabilities.**

`.homeycompose/capabilities/measure_fan_speed.json`
```json
{
  "type": "number",
  "title": { "en": "Fan speed" },
  "uiComponent": "sensor",
  "getable": true,
  "setable": false,
  "units": { "en": "%" },
  "min": 0,
  "max": 100,
  "decimals": 0,
  "insights": true,
  "icon": "/assets/fan.svg"
}
```
`.homeycompose/capabilities/ilo_health.json`
```json
{
  "type": "enum",
  "title": { "en": "Health" },
  "uiComponent": "sensor",
  "getable": true,
  "setable": false,
  "values": [
    { "id": "ok", "title": { "en": "OK" } },
    { "id": "warning", "title": { "en": "Warning" } },
    { "id": "critical", "title": { "en": "Critical" } }
  ]
}
```

**Step 2: Driver compose.**

`drivers/server/driver.compose.json`
```json
{
  "name": { "en": "HPE Server (iLO)" },
  "class": "other",
  "capabilities": [
    "onoff",
    "measure_power",
    "measure_temperature",
    "measure_temperature.cpu",
    "measure_fan_speed",
    "ilo_health"
  ],
  "capabilitiesOptions": {
    "onoff": { "title": { "en": "Power" } },
    "measure_temperature": { "title": { "en": "Inlet temperature" } },
    "measure_temperature.cpu": { "title": { "en": "CPU temperature" } }
  },
  "platforms": ["local"],
  "connectivity": ["lan"],
  "images": {
    "small": "/drivers/server/assets/images/small.png",
    "large": "/drivers/server/assets/images/large.png",
    "xlarge": "/drivers/server/assets/images/xlarge.png"
  },
  "settings": [
    {
      "type": "group",
      "label": { "en": "Connection" },
      "children": [
        { "id": "host", "type": "text", "label": { "en": "Host / IP" }, "value": "" },
        { "id": "allow_self_signed", "type": "checkbox", "label": { "en": "Allow self-signed certificate" }, "value": true, "hint": { "en": "iLO ships with a self-signed certificate. Disable only if you installed a trusted certificate." } }
      ]
    },
    {
      "type": "group",
      "label": { "en": "Polling" },
      "children": [
        { "id": "poll_interval", "type": "number", "label": { "en": "Poll interval (seconds)" }, "value": 30, "min": 10, "max": 3600, "step": 5, "units": { "en": "s" } }
      ]
    }
  ],
  "pair": [
    { "id": "login", "navigation": { "next": "list_devices" } },
    { "id": "list_devices", "template": "list_devices", "navigation": { "next": "add_devices" } },
    { "id": "add_devices", "template": "add_devices" }
  ]
}
```

**Step 3: Assets.** Homey requires driver images at the declared paths and an SVG icon. Provide placeholders so validation passes:
- `drivers/server/assets/icon.svg` — a simple server glyph (copy app `assets/icon.svg` for now).
- `drivers/server/assets/images/{small,large,xlarge}.png` — placeholder PNGs at 75×75 / 500×500 / 1000×1000 (publish-level sizes). For `debug` validation these can be any PNG; flag in README that final artwork is TODO.
- `assets/fan.svg` — icon for the custom fan capability (simple fan glyph).

Generate placeholder PNGs:
```bash
# requires nothing fancy; if `sips`/ImageMagick unavailable, create 1x1 transparent PNGs as placeholders
mkdir -p drivers/server/assets/images
# (executor: produce small/large/xlarge png placeholders here)
```

**Step 4: Validate.** `homey app validate --level debug` → success. (Capabilities and driver now merge into `app.json`.)

**Step 5: Commit** `feat(driver): server driver manifest, custom capabilities, assets`.

---

## Task 10: Pairing — custom login view + driver.ts onPair

**Files:**
- Create: `drivers/server/pair/login.html`
- Create: `drivers/server/driver.ts`

**Step 1: Pair view.**

`drivers/server/pair/login.html`
```html
<script type="application/javascript">
  function onHomeyReady(Homey) {
    Homey.setTitle('Connect to iLO');

    const btn = document.getElementById('connect');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await Homey.emit('manual_login', {
          host: document.getElementById('host').value.trim(),
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value,
          allowSelfSigned: document.getElementById('selfsigned').checked,
        });
        Homey.showView('list_devices');
      } catch (err) {
        Homey.alert(err && err.message ? err.message : String(err));
        btn.disabled = false;
      }
    });

    Homey.ready();
  }
</script>

<div class="homey-form-group">
  <label class="homey-form-label" for="host">Host / IP</label>
  <input id="host" class="homey-form-input" type="text" placeholder="192.168.1.50" />
</div>
<div class="homey-form-group">
  <label class="homey-form-label" for="username">Username</label>
  <input id="username" class="homey-form-input" type="text" placeholder="Administrator" />
</div>
<div class="homey-form-group">
  <label class="homey-form-label" for="password">Password</label>
  <input id="password" class="homey-form-input" type="password" />
</div>
<label class="homey-form-checkbox">
  <input id="selfsigned" type="checkbox" checked />
  <span class="homey-form-checkbox-checkmark"></span>
  <span class="homey-form-checkbox-text">Allow self-signed certificate</span>
</label>
<button id="connect" class="homey-button-primary-full">Connect</button>
```

**Step 2: Driver.**

`drivers/server/driver.ts`
```typescript
import Homey from 'homey';
import { IloClient } from '../../lib/IloClient';

interface PairCreds { host: string; username: string; password: string; allowSelfSigned: boolean; }

module.exports = class ServerDriver extends Homey.Driver {
  async onInit() {
    this.log('Server driver initialized');
    this.registerFlowCards();
  }

  async onPair(session: any) {
    let creds: PairCreds | undefined;

    session.setHandler('manual_login', async (data: PairCreds) => {
      if (!data.host || !data.username) throw new Error('Host and username are required');
      const client = new IloClient({
        host: data.host, username: data.username, password: data.password,
        allowSelfSigned: data.allowSelfSigned,
      });
      try {
        await client.probe();      // throws on bad host/creds/TLS
      } catch (err: any) {
        throw new Error(`Could not connect: ${err.message ?? err}`);
      }
      creds = data;
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!creds) return [];
      const client = new IloClient({
        host: creds.host, username: creds.username, password: creds.password,
        allowSelfSigned: creds.allowSelfSigned,
      });
      const info = await client.probe();
      return [{
        name: `${info.name} (${creds.host})`,
        data: { id: info.serialNumber },
        store: {
          host: creds.host,
          username: creds.username,
          password: creds.password,
        },
        settings: {
          host: creds.host,
          allow_self_signed: creds.allowSelfSigned,
          poll_interval: 30,
        },
      }];
    });
  }

  // Flow registration filled in Task 12.
  registerFlowCards() { /* see Task 12 */ }
};
```

**Step 3: Validate + build.** `homey app validate --level debug` and `npm run build` → no errors.

**Step 4: Commit** `feat(driver): manual-entry pairing with live connection check`.

---

## Task 11: Device.ts — polling, capability mapping, power control, settings

**Files:** Create `drivers/server/device.ts`

**Step 1: Implement.**
```typescript
import Homey from 'homey';
import { IloClient } from '../../lib/IloClient';

module.exports = class ServerDevice extends Homey.Device {
  private client!: IloClient;
  private pollTimer?: NodeJS.Timeout;

  async onInit() {
    this.buildClient();
    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await this.client.setPower(value ? 'On' : 'GracefulShutdown');
    });

    await this.setUnavailable(this.homey.__('connecting') ?? 'Connecting…').catch(() => undefined);
    await this.poll();
    this.startPolling();
  }

  private buildClient() {
    const store = this.getStore() as { host: string; username: string; password: string };
    const allowSelfSigned = this.getSetting('allow_self_signed') as boolean;
    const host = (this.getSetting('host') as string) || store.host;
    this.client = new IloClient({
      host, username: store.username, password: store.password, allowSelfSigned,
    });
  }

  private startPolling() {
    const seconds = (this.getSetting('poll_interval') as number) ?? 30;
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    this.pollTimer = this.homey.setInterval(() => { this.poll().catch(this.error); }, seconds * 1000);
  }

  private async poll() {
    try {
      const [power, watts, thermal, health] = await Promise.all([
        this.client.getPowerState(),
        this.client.getPowerWatts(),
        this.client.getThermal(),
        this.client.getHealth(),
      ]);

      if (power === 'on' || power === 'off') {
        await this.setCapabilityValue('onoff', power === 'on');
      }
      if (watts !== null) await this.setCapabilityValue('measure_power', watts);
      if (thermal.inletTemp !== undefined) await this.setCapabilityValue('measure_temperature', thermal.inletTemp);
      if (thermal.cpuTemp !== undefined) await this.setCapabilityValue('measure_temperature.cpu', thermal.cpuTemp);
      if (thermal.maxFanPercent !== undefined) await this.setCapabilityValue('measure_fan_speed', thermal.maxFanPercent);
      if (health !== 'unknown') await this.setCapabilityValue('ilo_health', health);

      await this.setAvailable();
    } catch (err: any) {
      await this.setUnavailable(`iLO unreachable: ${err.message ?? err}`).catch(() => undefined);
    }
  }

  async onSettings({ changedKeys }: { oldSettings: any; newSettings: any; changedKeys: string[] }): Promise<string | void> {
    if (changedKeys.includes('host') || changedKeys.includes('allow_self_signed')) {
      this.buildClient();
    }
    if (changedKeys.includes('poll_interval') || changedKeys.includes('host') || changedKeys.includes('allow_self_signed')) {
      this.startPolling();
    }
    await this.poll();
  }

  async onDeleted() { if (this.pollTimer) this.homey.clearInterval(this.pollTimer); }
  async onUninit() { if (this.pollTimer) this.homey.clearInterval(this.pollTimer); }

  // Public helpers for flow actions (Task 12)
  async actionPower(reset: 'On' | 'ForceOff' | 'GracefulShutdown' | 'GracefulRestart' | 'ForceRestart') {
    await this.client.setPower(reset);
  }
  getHealthValue(): string { return (this.getCapabilityValue('ilo_health') as string) ?? 'unknown'; }
  isPoweredOn(): boolean { return this.getCapabilityValue('onoff') === true; }
};
```

**Step 2: Validate + build.** `homey app validate --level debug`; `npm run build`.

**Step 3: Commit** `feat(device): polling, capability mapping, power control, settings`.

---

## Task 12: Flow cards (definitions + registration)

**Files:**
- Create: `.homeycompose/flow/triggers/health_changed.json`, `.../triggers/health_critical.json`
- Create: `.homeycompose/flow/conditions/is_on.json`, `.../conditions/health_is_ok.json`
- Create: `.../actions/turn_on.json`, `graceful_shutdown.json`, `force_off.json`, `warm_reset.json`, `cold_boot.json`
- Modify: `drivers/server/driver.ts` (`registerFlowCards`), `drivers/server/device.ts` (fire triggers)

**Step 1: Triggers.**
`.homeycompose/flow/triggers/health_changed.json`
```json
{
  "title": { "en": "Health status changed" },
  "args": [{ "name": "device", "type": "device", "filter": "driver_id=server" }],
  "tokens": [{ "name": "health", "type": "string", "title": { "en": "Health" }, "example": "warning" }]
}
```
`.homeycompose/flow/triggers/health_critical.json`
```json
{
  "title": { "en": "Health became critical" },
  "args": [{ "name": "device", "type": "device", "filter": "driver_id=server" }]
}
```

**Step 2: Conditions.**
`.homeycompose/flow/conditions/is_on.json`
```json
{
  "title": { "en": "Server !{{is|isn't}} powered on" },
  "args": [{ "name": "device", "type": "device", "filter": "driver_id=server" }]
}
```
`.homeycompose/flow/conditions/health_is_ok.json`
```json
{
  "title": { "en": "Health !{{is|isn't}} OK" },
  "args": [{ "name": "device", "type": "device", "filter": "driver_id=server" }]
}
```

**Step 3: Actions** (five files; `force_off` shown, others identical but for title/id).
`.homeycompose/flow/actions/force_off.json`
```json
{
  "title": { "en": "Force power off" },
  "titleFormatted": { "en": "Force power off [[device]]" },
  "args": [{ "name": "device", "type": "device", "filter": "driver_id=server" }]
}
```
Repeat for `turn_on.json` ("Turn on" → `On`), `graceful_shutdown.json` ("Graceful shutdown" → `GracefulShutdown`), `warm_reset.json` ("Restart (warm)" → `GracefulRestart`), `cold_boot.json` ("Cold boot (force restart)" → `ForceRestart`).

**Step 4: Register in `driver.ts`.** Replace `registerFlowCards()`:
```typescript
  private healthChanged?: Homey.FlowCardTriggerDevice;
  private healthCritical?: Homey.FlowCardTriggerDevice;

  registerFlowCards() {
    // Conditions
    this.homey.flow.getConditionCard('is_on')
      .registerRunListener(async (args: any) => (args.device as any).isPoweredOn());
    this.homey.flow.getConditionCard('health_is_ok')
      .registerRunListener(async (args: any) => (args.device as any).getHealthValue() === 'ok');

    // Actions
    const map: Record<string, 'On'|'ForceOff'|'GracefulShutdown'|'GracefulRestart'|'ForceRestart'> = {
      turn_on: 'On', graceful_shutdown: 'GracefulShutdown', force_off: 'ForceOff',
      warm_reset: 'GracefulRestart', cold_boot: 'ForceRestart',
    };
    for (const [cardId, reset] of Object.entries(map)) {
      this.homey.flow.getActionCard(cardId)
        .registerRunListener(async (args: any) => { await (args.device as any).actionPower(reset); });
    }

    // Device triggers (fired from device.ts)
    this.healthChanged = this.homey.flow.getDeviceTriggerCard('health_changed');
    this.healthCritical = this.homey.flow.getDeviceTriggerCard('health_critical');
  }

  triggerHealthChanged(device: Homey.Device, health: string) { this.healthChanged?.trigger(device, { health }, {}); }
  triggerHealthCritical(device: Homey.Device) { this.healthCritical?.trigger(device, {}, {}); }
```

**Step 5: Fire triggers from `device.ts`.** In `poll()`, before `setCapabilityValue('ilo_health', …)`:
```typescript
      if (health !== 'unknown') {
        const prev = this.getCapabilityValue('ilo_health');
        if (prev !== health) {
          (this.driver as any).triggerHealthChanged(this, health);
          if (health === 'critical') (this.driver as any).triggerHealthCritical(this);
        }
        await this.setCapabilityValue('ilo_health', health);
      }
```
(Replace the earlier single-line health set with this block.)

**Step 6: Validate + build.** `homey app validate --level debug`; `npm run build`.

**Step 7: Commit** `feat(flow): health triggers, power conditions and actions`.

---

## Task 13: Full validation, publish-level check, and manual run

**Files:** none (verification task)

**Step 1: Lint + unit tests + build.**
```bash
npm run lint
npm test
npm run build
```
Expected: lint clean (fix any issues), all unit tests pass, `tsc` no errors.

**Step 2: Debug validation.** `homey app validate --level debug` → success.

**Step 3: Publish-level validation** (surfaces missing real assets/metadata):
```bash
homey app validate --level publish
```
Expected: either success, or a precise list of missing items (e.g. real driver/app images at required sizes). Address image-size requirements; note any deferred artwork in README.

**Step 4: Manual run against hardware/mock** (requires a reachable iLO 5/6 or a Redfish mock; needs a Homey to attach to):
```bash
homey app run
```
Pair a device via the Homey app: enter host/credentials, confirm the device appears, capabilities populate within one poll interval, and the on/off toggle + flow actions work. **This is the staff-engineer acceptance gate — do not mark the app "done" until a real pairing + poll + power action has been observed, or explicitly note that no hardware was available and which checks were therefore not exercised.**

**Step 5: Commit** any fixes from this task.

---

## Task 14: Documentation

**Files:** Create `README.md`, update `README.txt` (Homey store description), `.homeychangelog.json`

**Step 1:** `README.md` — what the app does, supported iLO versions (5/6 via Redfish), capabilities, pairing instructions, the self-signed-cert note, polling/settings, and the iLO-5↔6 fallback behaviour. Reference `docs/plans/2026-05-22-hp-ilo-homey-app-design.md`.

**Step 2:** `README.txt` — concise end-user description for the Homey App Store.

**Step 3: Commit** `docs: README and changelog`.

---

## Notes & risks for the executor

- **Scaffold relocation (Task 0)** is the highest-risk step. If the piped `homey app create` doesn't take, use the manual-scaffold fallback verbatim — the end state must match a CLI-created TS app (especially `tsconfig.json` `outDir: ".homeybuild/"`).
- **`dispatcher` in fetch:** Node 24's `fetch` accepts undici's `dispatcher` option but the DOM-derived types don't include it — the `as any` cast in `defaultTransport` is intentional. Don't "fix" it by removing the cast.
- **Sub-capability flow cards:** none are auto-generated; we deliberately drive everything through our own cards + the built-in `onoff` triggers.
- **Sessions are scarce:** the device keeps **one** `IloClient` (one session) and reuses it; pairing's `probe()` always logs out. Don't create a client per poll.
- **No hardware in CI:** unit tests cover all `IloClient` logic via the injected transport; the live behaviours (TLS, real Redfish shapes) are only proven in Task 13 Step 4.
- **TDD discipline:** for Tasks 1–8 the test must fail first for the stated reason before implementing.

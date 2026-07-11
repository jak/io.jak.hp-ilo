import { Agent } from 'undici';
import type {
  HealthState, PowerState, ResetType, ThermalReading,
} from './redfish-types';

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
  /** Base delay between transient (503/429) retries, in ms. Set to 0 in tests. */
  retryDelayMs?: number;
  /** Per-request timeout in ms; an unreachable host fails fast instead of hanging. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

/** True when an error is the AbortError raised by an AbortSignal timeout. */
export function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Node TLS error codes that mean "the certificate could not be verified" —
 * i.e. the class of failure that enabling `allowSelfSigned` would bypass. */
const CERT_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** True when an error (or anything in its `cause` chain — undici's fetch wraps
 * the TLS error in a generic "fetch failed" TypeError) is a certificate
 * verification failure. */
export function isCertificateError(err: unknown): boolean {
  for (let e: any = err; e; e = e.cause) {
    if (e.certError === true) return true;
    if (typeof e.code === 'string' && CERT_ERROR_CODES.has(e.code)) return true;
  }
  return false;
}

function defaultTransport(allowSelfSigned: boolean, timeoutMs: number): HttpRequestFn {
  const dispatcher = allowSelfSigned
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;
  // Node 18+ exposes `fetch` as a global; @types/node@16 doesn't declare it,
  // so reach it via globalThis. The `dispatcher` option is undici-specific and
  // not in the DOM RequestInit type — hence the `as any` cast (intentional).
  const fetchFn: (url: string, init: any) => Promise<any> = (globalThis as any).fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('Global fetch is unavailable; Node 18+ is required');
  }
  return async (url, init) => {
    // Abort the request if the host is unreachable/slow, so a probe or poll
    // surfaces a clear error in the pairing UI instead of hanging forever.
    const signal = (AbortSignal as any).timeout(timeoutMs);
    let res: any;
    try {
      res = await fetchFn(url, { ...init, dispatcher, signal } as any);
    } catch (err) {
      if (isTimeoutAbort(err)) {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      if (isCertificateError(err)) {
        // undici's fetch surfaces this as a bare "fetch failed" — replace it
        // with a message that tells the user what to do about it.
        const e: any = new Error('The server\'s TLS certificate could not be verified (it is likely self-signed). Enable "Allow self-signed certificate" to connect anyway.');
        e.certError = true;
        e.cause = err;
        throw e;
      }
      throw err;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v: string, k: string) => {
      headers[k.toLowerCase()] = v;
    });
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
  private readonly retryDelayMs: number;
  /** Max retries for transient (503/429) responses, beyond the first attempt. */
  private static readonly MAX_TRANSIENT_RETRIES = 2;
  private authToken?: string;
  private sessionUri?: string;

  constructor(opts: IloClientOptions) {
    this.host = opts.host;
    this.username = opts.username;
    this.password = opts.password;
    // Secure by default: TLS verification stays on unless explicitly relaxed.
    this.transport = opts.transport ?? defaultTransport(opts.allowSelfSigned ?? false, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.retryDelayMs = opts.retryDelayMs ?? 500;
  }

  private url(path: string): string {
    return `https://${this.host}${path}`;
  }

  private sleep(ms: number): Promise<void> {
    // One-shot delay that resolves (and self-clears) immediately; this lib is
    // intentionally Homey-independent so it can't use this.homey.setTimeout.
    // eslint-disable-next-line homey-app/global-timers
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Delay before a transient retry; honors a numeric Retry-After header if present. */
  private retryDelayFor(res: HttpResponse): number {
    const retryAfter = Number(res.headers['retry-after']);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    return this.retryDelayMs;
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

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', 'OData-Version': '4.0' };
    if (this.authToken) h['X-Auth-Token'] = this.authToken;
    return h;
  }

  private async request(method: string, path: string, body?: unknown, _retry = true): Promise<HttpResponse> {
    if (!this.authToken) await this.login();

    // Bounded retry loop for transient 503/429 responses. The 401 re-auth-once
    // path is handled separately below and is independent of this counter.
    let transientAttempts = 0;
    for (;;) {
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

      if ((res.status === 503 || res.status === 429) && transientAttempts < IloClient.MAX_TRANSIENT_RETRIES) {
        transientAttempts += 1;
        await this.sleep(this.retryDelayFor(res));
        continue;
      }

      return res;
    }
  }

  async getJson(path: string): Promise<any> {
    const res = await this.request('GET', path);
    if (res.status === 404) {
      const e: any = new Error(`Not found: ${path}`);
      e.status = 404;
      throw e;
    }
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

  private join(base: string, sub: string): string {
    return base.endsWith('/') ? base + sub : `${base}/${sub}`;
  }

  /** GET that returns null on 404 instead of throwing. */
  private async getJsonOrNull(path: string): Promise<any | null> {
    try {
      return await this.getJson(path);
    } catch (e: any) {
      if (e?.status === 404) return null;
      throw e;
    }
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

  async probe(): Promise<{ name: string; serialNumber: string; model: string }> {
    try {
      await this.login();
      return await this.getServerInfo();
    } finally {
      await this.logout().catch(() => undefined);
    }
  }
}

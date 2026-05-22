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
  // Node 18+ exposes `fetch` as a global; @types/node@16 doesn't declare it,
  // so reach it via globalThis. The `dispatcher` option is undici-specific and
  // not in the DOM RequestInit type — hence the `as any` cast (intentional).
  const fetchFn: (url: string, init: any) => Promise<any> = (globalThis as any).fetch;
  return async (url, init) => {
    const res = await fetchFn(url, { ...init, dispatcher } as any);
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
}

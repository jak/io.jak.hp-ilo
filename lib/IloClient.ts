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
}

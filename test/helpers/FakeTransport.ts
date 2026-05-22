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

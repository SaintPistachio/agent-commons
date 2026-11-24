import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, CommonsError } from './store.ts';
import { Runner, type RunnerOptions } from './runner.ts';
import { Prober } from './prober.ts';
import { MemoryEmbedder, loadEmbeddingsConfig } from './embeddings.ts';
import { parsePacket } from './air/parser.ts';
import { ensureTokenHome, writePrivateJson } from './token-home.ts';
import type { WorkerPolicy } from './worker-policy.ts';

export const DEFAULT_PORT = 4727;

/** The installed release's identity (release.json written by Install-AgentCommonsV2.ps1), or null for a checkout. */
export function releaseInfo(file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'release.json')): Record<string, unknown> | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { commit: r.commit ?? null, v2_tree: r.v2_tree ?? null, installed_at: r.installed_at ?? null, node: r.node?.version ?? null };
  } catch { return null; }
}
const MAX_BODY = 8 * 1024 * 1024;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i;
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i;

/** Reject DNS-rebinding Host headers and cross-site browser Origin / Sec-Fetch-Site requests before dispatch. */
export function checkLoopbackHeaders(headers: http.IncomingHttpHeaders, boundPort: number): { status: number; code: string; message: string } | null {
  const host = headers.host;
  const hostMatch = typeof host === 'string' ? LOOPBACK_HOST.exec(host) : null;
  if (!hostMatch || (hostMatch[2] !== undefined ? Number(hostMatch[2]) : 80) !== boundPort) {
    return { status: 403, code: 'FORBIDDEN_HOST', message: 'loopback Host header required' };
  }
  const origin = headers.origin;
  if (origin !== undefined) {
    const originMatch = typeof origin === 'string' ? LOOPBACK_ORIGIN.exec(origin) : null;
    if (!originMatch || (originMatch[2] !== undefined ? Number(originMatch[2]) : 80) !== boundPort) {
      return { status: 403, code: 'FORBIDDEN_ORIGIN', message: 'cross-origin request refused' };
    }
  }
  const fetchSite = headers['sec-fetch-site'];
  if (fetchSite !== undefined) {
    const value = typeof fetchSite === 'string' ? fetchSite.toLowerCase() : '';
    if (value !== 'same-origin' && value !== 'none') {
      return { status: 403, code: 'FORBIDDEN_ORIGIN', message: 'cross-site browser request refused' };
    }
  }
  return null;
}

export interface Running { url: string; close(): Promise<void>; store: Store }
export interface ServerOptions {
  /** The installed service (cli.ts serve) runs the platform probes; tests leave it off so they never start real CLIs. */
  probe?: boolean;
  /** Called once the service has closed after POST /api/v1/shutdown (cli.ts serve exits the process). */
  onShutdown?: () => void;
  /** In-process test seam for fake adapters. The CLI always uses the configured local or default policy. */
  workerPolicy?: WorkerPolicy;
}

export function extractRecallQueries(method: string, input: Record<string, unknown>): string[] {
  const queries: string[] = [];
  if (method === 'air_get' && typeof input.handles === 'string') {
    for (const raw of input.handles.split(',')) {
      const m = /^(?:p[1-9]\d*:)?(?:\?|recall:)(.+)$/.exec(raw.trim());
      if (m?.[1]?.trim()) queries.push(m[1].trim());
    }
  } else if (method === 'job_submit' && Array.isArray(input.context_refs)) {
    for (const ref of input.context_refs) {
      if (typeof ref === 'string' && ref.startsWith('recall:') && ref.slice(7).trim()) {
        queries.push(ref.slice(7).trim());
      }
    }
  } else if (method === 'air_tx' && typeof input.packet === 'string') {
    try {
      const parsed = parsePacket(input.packet);
      for (const node of parsed.nodes) {
        for (const item of node.fields.ctx ?? []) {
          if ('text' in item && item.text.startsWith('recall:') && item.text.slice(7).trim()) {
            queries.push(item.text.slice(7).trim());
          }
        }
      }
    } catch { /* let store.call report syntax errors synchronously */ }
  }
  return [...new Set(queries)];
}

/**
 * Loopback HTTP JSON API: GET /health, POST /api/v1/call {method,input} with a bearer token, and POST
 * /api/v1/shutdown for a graceful stop (the operator's token, or the per-start token in runtime.json that
 * cli.ts stop reads; participants get 403).
 */
export async function startServer(home: string, port = DEFAULT_PORT, runnerOptions: RunnerOptions | false = {}, serverOptions: ServerOptions = {}): Promise<Running> {
  ensureTokenHome(home);
  if (fs.existsSync(path.join(home, '.restore.lock'))) throw new Error('A backup restore is in progress for this home');
  const store = new Store(home, serverOptions.workerPolicy);
  // Delegated jobs run inside the service, so they outlive the app that submitted them.
  const runner = runnerOptions === false ? null : new Runner(store, home, runnerOptions);
  const prober = runnerOptions !== false && serverOptions.probe ? new Prober(store, home, runnerOptions) : null;
  let embedder: MemoryEmbedder | null = null;
  if (runnerOptions !== false) {
    try {
      if (loadEmbeddingsConfig(home)) embedder = new MemoryEmbedder(store.db, home);
    } catch { /* invalid embeddings.json does not prevent server startup */ }
  }
  const shutdownToken = randomBytes(32).toString('hex');
  const release = releaseInfo();
  let closing: Promise<void> | undefined;
  const server = http.createServer((request, response) => {
    // A caller that hung up (for example during air_wait) gets nothing written to its closed socket.
    const send = (status: number, body: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
    };
    const boundPort = (server.address() as { port: number } | null)?.port;
    if (boundPort !== undefined) {
      const blocked = checkLoopbackHeaders(request.headers, boundPort);
      if (blocked) { request.resume(); return send(blocked.status, { error: { code: blocked.code, message: blocked.message } }); }
    }
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (request.method === 'GET' && request.url === '/health') return send(200, { status: 'ready', service: 'agent-commons-v2', ...store.serviceCounts(), ...(release ? { release } : {}) });
    if (request.method === 'POST' && request.url === '/api/v1/shutdown') {
      request.resume();
      const runtime = !!bearer && bearer.length === shutdownToken.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(shutdownToken));
      if (!runtime) {
        let actor;
        try { actor = store.authenticate(bearer); } catch { return send(401, { error: { code: 'UNAUTHENTICATED' } }); }
        if (actor.role !== 'operator') return send(403, { error: { code: 'FORBIDDEN', message: 'only the operator can stop the service' } });
      }
      send(200, { result: { stopping: true } });
      setImmediate(() => { void close().then(() => serverOptions.onShutdown?.()); });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/api/v1/call') return send(404, { error: { code: 'NOT_FOUND' } });
    const chunks: Buffer[] = []; let size = 0;
    request.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) request.destroy(); else chunks.push(chunk); });
    request.on('end', async () => {
      try {
        const actor = store.authenticate(bearer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (typeof body.method !== 'string') throw new CommonsError('INVALID_INPUT', 'method is required');
        const input = body.input ?? {};
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CommonsError('INVALID_INPUT');
        // air_wait is the one asynchronous method: it holds the request open until its jobs finish (at most 50 s),
        // and ends at once, removing its listeners, if the caller disconnects first.
        if (body.method === 'air_wait') {
          const hangUp = new AbortController();
          response.on('close', () => { if (!response.writableEnded) hangUp.abort(); });
          return send(200, { result: await store.airWait(actor, input, hangUp.signal) });
        }
        const queries = extractRecallQueries(body.method, input);
        if (queries.length) {
          const vectors = await store.embedRecallQueries(queries);
          if (vectors.size) {
            return send(200, { result: store.withRecallVectors(vectors, () => store.call(actor, body.method, input)) });
          }
        }
        send(200, { result: store.call(actor, body.method, input) });
      } catch (error) {
        if (error instanceof CommonsError) return send(error.status, { error: { code: error.code, message: error.message } });
        if (error instanceof SyntaxError) return send(400, { error: { code: 'INVALID_JSON' } });
        console.error(JSON.stringify({ event: 'request.failed', error: String((error as Error)?.message ?? error) }));
        send(500, { error: { code: 'INTERNAL_ERROR' } });
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  try {
    writePrivateJson(path.join(home, 'runtime.json'), { url, pid: process.pid, started_at: new Date().toISOString(), shutdown_token: shutdownToken }, true);
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    throw error;
  }
  runner?.start();
  prober?.start();
  embedder?.start();
  // Closing twice (a shutdown request, then a signal) does the work once.
  const close = () => closing ??= new Promise<void>(resolve => {
    store.wakeWaiters(); // pending air_wait calls answer now instead of holding the shutdown open
    embedder?.stop();
    prober?.stop();
    runner?.stop();
    server.close(() => { store.close(); try { fs.rmSync(path.join(home, 'runtime.json')); } catch {} resolve(); });
    server.closeIdleConnections(); // keep-alive clients would otherwise hold close() open
  });
  return { url, store, close };
}

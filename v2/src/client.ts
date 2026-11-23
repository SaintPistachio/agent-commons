import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

/**
 * Same shape as v1 connection files, so a native app switches by pointing at a new file. toolProfile ("full" by
 * default, or "air") picks which tools the MCP bridge lists; it lives here, so changing it never touches an app's config.
 */
export interface Connection { url: string; token: string; actorId: string; projectIds?: string[]; selectProject?: boolean; toolProfile?: string }

export function readConnection(file: string): Connection {
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (typeof value?.url !== 'string' || typeof value.token !== 'string' || typeof value.actorId !== 'string') throw new Error('INVALID_CONNECTION_FILE');
  return value;
}

export class RemoteError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

/** Only transport failures are safe to retry; malformed replies and local errors are not. */
export function isRetryableTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || error instanceof RemoteError) return false;
  const e = error as { code?: string; name?: string; message?: string; cause?: { name?: string } };
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_SOCKET_TIMEOUT', 'ERR_HTTP_REQUEST_TIMEOUT'].includes(e.code ?? ''))
    return true;
  if (e.name === 'TimeoutError' || (e.code === 'ABORT_ERR' && e.cause?.name === 'TimeoutError')) return true;
  return e.message === 'socket hang up';
}

export async function call(connection: Connection, method: string, input: Record<string, unknown> = {}, timeoutMs?: number): Promise<any> {
  // Explicit timeouts are hard budgets (used by air-wait-until). Otherwise allow air_wait's hold plus a margin.
  timeoutMs ??= method === 'air_wait'
    ? Math.max(30000, (Math.min(Number(input.wait_seconds ?? 30) || 30, 50) + 15) * 1000) : 30000;
  // No keep-alive: a pooled fetch socket still closing when a CLI client calls process.exit()
  // can trip a libuv assertion on Windows (seen after two calls in one air-result run).
  const url = new URL('/api/v1/call', connection.url);
  const transport = url.protocol === 'https:' ? https : http;
  const payload = Buffer.from(JSON.stringify({ method, input }), 'utf8');
  const text = await new Promise<string>((resolve, reject) => {
    const request = transport.request(url, {
      method: 'POST', agent: false, signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json', 'content-length': payload.length },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(payload);
  });
  const body = JSON.parse(text) as any;
  if (body?.error) throw new RemoteError(body.error.code, body.error.message ?? body.error.code);
  return body.result;
}

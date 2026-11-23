import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { call, isRetryableTransportError, RemoteError } from '../src/client.ts';

test('connection protocol selects HTTPS while retaining agent:false', async () => {
  const original = https.request;
  let called = false;
  https.request = ((url: URL, options: any, callback: (response: EventEmitter) => void) => {
    called = true;
    assert.equal(url.protocol, 'https:');
    assert.equal(url.pathname, '/api/v1/call');
    assert.equal(options.agent, false);
    const request = new EventEmitter() as EventEmitter & { end(payload: Buffer): void };
    request.end = payload => {
      assert.equal(JSON.parse(payload.toString()).method, 'air_get');
      queueMicrotask(() => {
        const response = new EventEmitter();
        callback(response);
        response.emit('data', Buffer.from('{"result":{"air":"ok"}}'));
        response.emit('end');
      });
    };
    return request;
  }) as unknown as typeof https.request;
  try {
    assert.deepEqual(await call({ url: 'https://localhost:443', token: 'token', actorId: 'actor' }, 'air_get'), { air: 'ok' });
    assert.equal(called, true);
  } finally { https.request = original; }
});

test('retry classification includes only explicit transport failures', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_SOCKET_TIMEOUT']) {
    assert.equal(isRetryableTransportError(Object.assign(new Error(code), { code })), true);
  }
  assert.equal(isRetryableTransportError(new Error('socket hang up')), true);
  assert.equal(isRetryableTransportError(Object.assign(new Error('aborted'), {
    code: 'ABORT_ERR', cause: new DOMException('expired', 'TimeoutError'),
  })), true);
  for (const error of [
    new SyntaxError('invalid JSON'), new TypeError('bad local input'), new Error('timeout in local parser'),
    new RemoteError('ECONNRESET', 'remote application error'),
    Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }),
  ]) assert.equal(isRetryableTransportError(error), false);
});

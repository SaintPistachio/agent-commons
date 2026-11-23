import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

async function fixture(t: any, handle: (body: any, response: http.ServerResponse) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-review-cli-'));
  const requests: any[] = [];
  const server = http.createServer((request, response) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { text += chunk; });
    request.on('end', () => {
      const body = JSON.parse(text);
      requests.push(body);
      handle(body, response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = path.join(home, 'connection.json');
  fs.writeFileSync(connection, JSON.stringify({
    url: `http://127.0.0.1:${address.port}`, token: 'test', actorId: 'test',
  }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const run = (args: string[], env: Record<string, string> = {}, preload?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string; elapsed: number }>(resolve => {
      const started = Date.now();
      execFile(process.execPath, [
        ...(preload ? ['--import', pathToFileURL(preload).href] : []), CLI, ...args, '--connection', connection,
      ], {
        env: { ...process.env, ...env }, timeout: 12000, maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        resolve({
          code: error ? typeof error.code === 'number' ? error.code : -1 : 0,
          stdout, stderr, elapsed: Date.now() - started,
        });
      });
    });
  return { home, requests, run };
}

const send = (response: http.ServerResponse, air: string) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ result: { air } }));
};
const waitEnv = (seconds: number) => ({
  AC_WAIT_SLICE_SECONDS: '1', AC_WAIT_DEADLINE_SECONDS: String(seconds),
});
const waiting = '@air1 wait n=1 done=0 timeout=1';
const finished = '@air1 wait n=1 done=1 timeout=0';

test('air-wait-until propagates malformed JSON immediately, without retries', async t => {
  const f = await fixture(t, (_body, response) => response.end('not JSON'));
  const result = await f.run(['air-wait-until', '--handles', 'j1'], waitEnv(5));
  assert.equal(result.code, 1);
  assert.equal(f.requests.length, 1);
});

test('air-wait-until propagates malformed result objects immediately', async t => {
  const f = await fixture(t, (_body, response) => response.end('{"result":{"air":17}}'));
  const result = await f.run(['air-wait-until', '--handles', 'j1'], waitEnv(5));
  assert.equal(result.code, 1);
  assert.equal(f.requests.length, 1);
});

test('air-wait-until does not retry RemoteError, even with a transport-like code', async t => {
  const f = await fixture(t, (_body, response) => response.end(JSON.stringify({
    error: { code: 'ECONNRESET', message: 'application refusal' },
  })));
  const result = await f.run(['air-wait-until', '--handles', 'j1'], waitEnv(5));
  assert.equal(result.code, 1);
  assert.equal(f.requests.length, 1);
});

test('air-wait-until retries transport resets and closing replies using only air_wait', async t => {
  let n = 0;
  const f = await fixture(t, (_body, response) => {
    if (++n === 1) response.destroy();
    else if (n === 2) send(response, '@air1 wait closing=1');
    else send(response, finished);
  });
  const result = await f.run(['air-wait-until', '--handles', 'j1'], waitEnv(7));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every(request => request.method === 'air_wait' && request.input.wait_seconds === 1));
});

test('air-wait-until bounds retry sleep and sends no request after the deadline', async t => {
  const f = await fixture(t, (_body, response) => response.destroy());
  const result = await f.run(['air-wait-until', '--handles', 'j1'], waitEnv(1.3));
  assert.equal(result.code, 1);
  assert.equal(f.requests.length, 1);
  assert.ok(result.elapsed < 3000, `elapsed ${result.elapsed}`);
});

test('air-wait-until retains a usable unfinished reply across transport failures', async t => {
  let n = 0;
  const f = await fixture(t, (_body, response) => {
    if (++n === 1) send(response, waiting);
    else response.destroy();
  });
  const result = await f.run(['air-wait-until', '--handles', 'j1'], waitEnv(1.3));
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /done=0\/1/);
  assert.equal(f.requests.length, 2);
  assert.ok(result.elapsed < 3000, `elapsed ${result.elapsed}`);
});

test('air-wait-until enforces the remaining-time timeout on a stalled request', async t => {
  let n = 0;
  const f = await fixture(t, (_body, response) => {
    if (++n === 1) send(response, waiting);
    // The next request never responds; the client's remaining-time budget must abort it.
  });
  const result = await f.run(['air-wait-until', '--handles', 'j1'], waitEnv(1.4));
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(f.requests.length, 2);
  assert.ok(result.elapsed < 3200, `elapsed ${result.elapsed}`);
  assert.ok(f.requests.every(request => request.input.wait_seconds === 1));
});

test('air-wait-until returns error when a stalled request yields no usable reply', async t => {
  const f = await fixture(t, () => {});
  const result = await f.run(['air-wait-until', '--handles', 'j1'], waitEnv(1.3));
  assert.equal(result.code, 1);
  assert.equal(f.requests.length, 1);
  assert.ok(result.elapsed < 3000, `elapsed ${result.elapsed}`);
});

async function resultFixture(t: any, artifactName?: string) {
  return fixture(t, (body, response) => {
    assert.equal(body.method, 'air_get');
    const raw = body.input.handles.split(',').map((handle: string) => handle === 'j1' ? {
      handle: 'j1', id: 'job', kind: 'job', content: 'job result', complete: true,
      artifacts: artifactName ? [{ handle: 'a1', name: artifactName, kind: 'text', bytes: 8 }] : [],
    } : {
      handle: 'a1', id: 'artifact', kind: 'artifact', content: 'artifact', complete: true,
    });
    response.end(JSON.stringify({ result: { air: '@air1 get n=1', raw } }));
  });
}

test('air-result atomically refuses a destination created at publication time', async t => {
  const f = await resultFixture(t);
  const hook = path.join(f.home, 'race.mjs');
  fs.writeFileSync(hook, `
    import fs from 'node:fs';
    const link = fs.linkSync;
    fs.linkSync = (source, target) => {
      fs.writeFileSync(target, 'concurrent writer', { flag: 'wx' });
      return link(source, target);
    };
  `);
  const target = path.join(f.home, 'out.txt');
  const result = await f.run(['air-result', '--handles', 'j1', '--out', target], {}, hook);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FILE_EXISTS/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent writer');
  assert.deepEqual(fs.readdirSync(f.home).filter(name => name.includes('.tmp-')), []);
  const forced = await f.run(['air-result', '--handles', 'j1', '--out', target, '--force'], {}, hook);
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'job result');
});

test('air-result refuses parent traversal and absolute artifact names before writing', async t => {
  for (const name of ['../x.txt', path.resolve(os.tmpdir(), 'ac2-absolute-artifact.txt')]) {
    const f = await resultFixture(t, name);
    const dir = path.join(f.home, 'output');
    const result = await f.run(['air-result', '--handles', 'j1', '--out-dir', dir, '--artifacts']);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Unsafe artifact name/);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(path.join(f.home, 'x.txt')), false);
  }
});

test('air-result detects case-insensitive duplicate destinations on Windows, even with force', async t => {
  const f = await resultFixture(t, 'J1.txt');
  const hook = path.join(f.home, 'windows.mjs');
  fs.writeFileSync(hook, `Object.defineProperty(process, 'platform', { value: 'win32' });`);
  const dir = path.join(f.home, 'output');
  const result = await f.run([
    'air-result', '--handles', 'j1', '--out-dir', dir, '--artifacts', '--force',
  ], {}, hook);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Duplicate output path/);
  assert.equal(fs.existsSync(dir), false);
});

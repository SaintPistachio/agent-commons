import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { codex } from '../src/adapters/codex.ts';

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-codex-inventory-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = path.join(home, 'app-server.mjs');
  fs.writeFileSync(script, `
import assert from 'node:assert/strict';
import readline from 'node:readline';
const mode = process.argv[2];
let firstPages = 0;
const send = frame => console.log(JSON.stringify(frame));
const model = (name, effort, hidden = false) => ({
  id: 'catalog/' + name, model: name, hidden, supportedReasoningEfforts: [{ reasoningEffort: effort }],
});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') return send({ id: request.id, result: {} });
  if (request.method === 'initialized') return;
  assert.equal(request.method, 'model/list');
  assert.equal(request.params.includeHidden, true);
  assert.equal(request.params.limit, 64);
  if (mode === 'unsupported') return send({ id: request.id, error: { code: -32601 } });
  if (mode === 'unauthorized') return send({ id: request.id, error: { code: -32001 } });
  if (!request.params.cursor) {
    firstPages++;
    assert.equal(request.id, firstPages === 1 ? 2 : 4);
    return send({ id: request.id,
      result: { data: [model('gpt-6.2-sol', 'high')], nextCursor: 'next-page' } });
  }
  assert.equal(request.params.cursor, 'next-page');
  assert.equal(request.id, firstPages === 1 ? 3 : 5);
  const data = [model('gpt-6.2-astra', 'max', true)];
  if (mode === 'account-changed' || mode === 'account-once' && firstPages === 1)
    send({ method: 'account/updated', params: {} });
  if (mode === 'partial') return send({ id: request.id, result: { data } });
  if (mode === 'late-unsupported') return send({ id: request.id, error: { code: -32601 } });
  if (mode === 'cycle') return send({ id: request.id, result: { data, nextCursor: 'next-page' } });
  if (mode === 'malformed') data[0].supportedReasoningEfforts = [{ reasoningEffort: 3 }];
  if (mode === 'duplicate') data[0] = model('gpt-6.2-sol', 'high');
  send({ id: request.id, result: { data, nextCursor: null } });
});
`);
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
    client_version: '0.171.0',
    fetched_at: new Date().toISOString(),
    models: [{ slug: 'gpt-6.2-sol', visibility: 'list',
      supported_reasoning_levels: [{ effort: 'medium' }], default_reasoning_level: 'medium' }],
  }));
  return (mode?: string, cliVersion = '0.171.0') => codex.discover!({
    home, overrides: { cliModelHome: home }, cliVersion,
    options: mode === undefined ? {} : { codex: { file: process.execPath, prefix: [script, mode] } },
  });
}

test('Codex discovers complete native pages with live efforts and catalog-only rows', async t => {
  const discover = fixture(t);
  const rows = await discover('ok');
  assert.deepEqual([...rows], [
    { model: 'gpt-6.2-sol', family: 'sol', efforts: ['high'], hidden: false, source: 'app-server', state: 'verified' },
    { model: 'gpt-6.2-astra', family: 'astra', efforts: ['max'], hidden: true, source: 'app-server', state: 'discovered' },
  ]);
  assert.deepEqual(rows.completeSources, ['app-server', 'app-server:hidden', 'cli-cache', 'cli-cache:hidden']);
  assert.deepEqual(await discover('account-once'), rows);
});

test('Codex uses only version-matched cache when native listing is unavailable', async t => {
  const discover = fixture(t);
  for (const mode of [undefined, 'unsupported']) {
    const rows = await discover(mode);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'cli-cache');
    assert.deepEqual(rows[0].efforts, ['medium']);
    assert.deepEqual(rows.completeSources, ['cli-cache', 'cli-cache:hidden']);
  }
  await assert.rejects(discover('unsupported', '0.170.0'), /client_version does not match/);
});

test('Codex rejects partial, malformed, repeated, or unauthorized listings despite a fresh cache', async t => {
  const discover = fixture(t);
  await assert.rejects(discover('partial'), /malformed metadata response/);
  await assert.rejects(discover('malformed'), /malformed metadata response/);
  await assert.rejects(discover('duplicate'), /malformed metadata response/);
  await assert.rejects(discover('cycle'), /pagination did not finish/);
  await assert.rejects(discover('account-changed'), /account changed/);
  await assert.rejects(discover('unauthorized'), /request was rejected/);
  await assert.rejects(discover('late-unsupported'), /request was rejected/);
});

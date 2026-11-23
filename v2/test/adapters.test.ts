// Fabric Stage 2a: routes come from the adapter registry; the store and runner name no platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adapterIds, allAdapters, adapter, DEFAULT_ROUTE } from '../src/adapters/registry.ts';
import { listedTools } from '../src/tools.ts';

const source = (file: string) => fs.readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');

test('the registry lists the four routes, claude first, with consistent capabilities', () => {
  assert.deepEqual(adapterIds(), ['claude', 'codex', 'openai-api', 'antigravity']);
  assert.equal(DEFAULT_ROUTE, 'auto');
  for (const a of allAdapters()) {
    const c = a.capabilities;
    assert.ok(c.modes.length && c.defaultTimeoutMinutes <= c.maxTimeoutMinutes && c.maxTimeoutMinutes <= 240, c.id);
    assert.equal(adapter(c.id), a);
  }
  // Only the paid route can spend money, and only it asks its platform for outcomes after a restart.
  assert.deepEqual(allAdapters().filter(a => a.capabilities.billing === 'paid').map(a => a.capabilities.id), ['openai-api']);
  assert.deepEqual(allAdapters().filter(a => a.reconcile).map(a => a.capabilities.id), ['openai-api']);
});

test('job_submit offers exactly the registered routes', () => {
  const tool = listedTools('full').find(t => t.name === 'job_submit')!;
  assert.deepEqual(tool.inputSchema.properties.route.enum, [...adapterIds(), 'auto']);
});

test('the store and runner contain no platform names or model defaults', () => {
  for (const file of ['store.ts', 'runner.ts']) {
    const code = source(file).split('\n').filter(line => !/^\s*(\/\/|\*|\/\*\*)/.test(line) && !/^export \{ resolve/.test(line)).join('\n');
    for (const name of ["'claude'", "'codex'", "'openai-api'", "'antigravity'", 'gpt-6']) assert.ok(!code.includes(name), `${file} mentions ${name}`);
  }
});

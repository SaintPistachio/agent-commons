import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, type Json } from '../src/store.ts';
import { Runner } from '../src/runner.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function fixture(t: any) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-review-store-'));
  const store = new Store(home);
  t.after(() => { store.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, store };
}

test('newerAvailable compares complete model lines even with broad stored families', t => {
  const { store } = fixture(t);
  // Fill required bookkeeping columns without coupling the test to their defaults.
  const columns = store.db.prepare('PRAGMA table_info(route_models)').all() as Array<{
    name: string; type: string; notnull: number; dflt_value: unknown;
  }>;
  const add = (model: string, state: string) => {
    const values: Record<string, string | number> = {
      route: 'antigravity', model, family: 'broad', state, source: 'catalog', operator_state: 0,
    };
    for (const column of columns) {
      if (column.name in values || !column.notnull || column.dflt_value !== null) continue;
      values[column.name] = /INT|REAL/i.test(column.type) ? 0
        : /effort|json/i.test(column.name) ? '[]' : new Date().toISOString();
    }
    const names = Object.keys(values).filter(name => columns.some(column => column.name === name));
    store.db.prepare(`INSERT INTO route_models(${names.map(name => `"${name}"`).join(',')}) VALUES(${names.map(() => '?').join(',')})`)
      .run(...names.map(name => values[name]));
  };
  add('gpt-6-luna', 'preferred');
  add('gpt-6.1-luna', 'discovered');
  add('gpt-6.1-sol', 'discovered');
  add('claude-opus-5-5', 'preferred');
  add('claude-opus-5-6', 'discovered');
  add('gemini-3.8-flash', 'preferred');
  add('gemini-4-flash', 'discovered');
  add('gemini-4-argon', 'discovered');
  assert.deepEqual(store.newerAvailable().map(row => `${row.old}->${row.new}`).sort(), [
    'claude-opus-5-5->claude-opus-5-6',
    'gemini-3.8-flash->gemini-4-flash',
    'gpt-6-luna->gpt-6.1-luna',
  ].sort());
});

test('a usage-recording failure cannot prevent a terminal job update', t => {
  const { home, store } = fixture(t);
  const { actor } = store.createActor('review-test', 'participant', 'review-test');
  const project = store.call(actor, 'project_create', { name: 'Review', root: home, operation_id: randomUUID() }).project;
  const job = store.call(actor, 'job_submit', {
    project_id: project.id, route: 'antigravity', prompt: 'test', operation_id: randomUUID(),
  }).job;
  store.updateJob(job.id, { status: 'running' });
  const original = store.recordUsage;
  const logs: string[] = [], log = console.error;
  store.recordUsage = () => { throw new Error('usage write failed'); };
  console.error = value => { logs.push(String(value)); };
  try {
    const runner = new Runner(store, home);
    (runner as unknown as {
      finish(id: string, status: string, fields: Json, reply: Json): void;
    }).finish(job.id, 'completed', { result: 'saved' }, { status: 'SUCCESS', response: 'saved' });
  } finally {
    store.recordUsage = original;
    console.error = log;
  }
  assert.equal(store.jobRecord(job.id)!.status, 'completed');
  assert.equal(store.jobRecord(job.id)!.result, 'saved');
  assert.ok(logs.some(line => line.includes('runner.usage_failed') && line.includes('usage write failed')));
});

test('mixed limits validate all numbers before writing', t => {
  const { store } = fixture(t);
  for (const global of [NaN, 0, 1.5, 17]) {
    assert.throws(() => store.setLimits({ route: { route: 'antigravity', max: 2 }, global }));
    assert.equal(store.routeLimitOverride('antigravity'), null);
    assert.equal(store.globalLimitSetting(), null);
    assert.equal(store.platformState('antigravity'), undefined);
  }
  for (const max of [NaN, 0, 1.5, 3]) {
    assert.throws(() => store.setLimits({ route: { route: 'antigravity', max }, global: 4 }));
    assert.equal(store.globalLimitSetting(), null);
  }
});

test('mixed limits roll back the route change if the global write fails', t => {
  const { store } = fixture(t);
  store.setRouteLimit('antigravity', 1);
  store.setGlobalLimit(3);
  store.db.exec(`CREATE TEMP TRIGGER refuse_global_limit BEFORE UPDATE ON service_settings
    BEGIN SELECT RAISE(ABORT, 'injected global write failure'); END`);
  assert.throws(() => store.setLimits({
    route: { route: 'antigravity', max: 2 }, global: 4,
  }), /injected global write failure/);
  assert.equal(store.routeLimitOverride('antigravity'), 1);
  assert.equal(store.globalLimitSetting(), 3);
  store.db.exec('DROP TRIGGER refuse_global_limit');
  store.setLimits({ route: { route: 'antigravity', max: 2 }, global: 4 });
  assert.equal(store.routeLimitOverride('antigravity'), 2);
  assert.equal(store.globalLimitSetting(), 4);
});

test('limits CLI refuses an invalid mixed request without partially applying it', t => {
  const { home, store } = fixture(t);
  assert.throws(() => execFileSync(process.execPath, [
    CLI, 'limits', '--home', home, '--route', 'antigravity', '--max', '2', '--global', 'BAD',
  ], { stdio: 'pipe' }), (error: any) => error.status === 2);
  assert.equal(store.routeLimitOverride('antigravity'), null);
  assert.equal(store.globalLimitSetting(), null);
});

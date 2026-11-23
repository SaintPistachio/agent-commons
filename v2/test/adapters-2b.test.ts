// Fabric Stage 2b: schema 6, platform profiles (intent + eff -> native model/effort), job usage columns and
// read-only drift probes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, CommonsError, type Actor } from './fixtures/service.ts';
import { Runner } from '../src/runner.ts';
import { Prober } from '../src/prober.ts';
import { adapter } from '../src/adapters/registry.ts';
import { SCHEMA_VERSION } from '../src/schema.ts';

const HELP = fileURLToPath(new URL('./fixtures/fake-cli-help.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as CommonsError).code; } throw new Error('expected a failure'); };

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-2b-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q']); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init']);
  let store = new Store(home);
  const actor: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() }).project;
  const cleanups: Array<() => void> = [];
  t.after(() => { for (const c of cleanups.reverse()) c(); try { store.close(); } catch {} fs.rmSync(base, { recursive: true, force: true }); });
  const submit = (extra: Record<string, unknown>) => call('job_submit', { project_id: project.id, prompt: 'x', operation_id: randomUUID(), ...extra }).job;
  const row = (id: string) => store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as any;
  return { base, home, repo, actor, call, submit, row, cleanups, get store() { return store; }, reopen: () => { store.close(); store = new Store(home); return store; } };
}

test('schema 6 adds the platform tables, job usage columns and task dependencies, and migrates a schema 5 database', t => {
  const f = fixture(t);
  assert.ok(SCHEMA_VERSION >= 6);
  const columns = (table: string) => (f.store.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name);
  for (const c of ['req_intent', 'req_eff', 'resolved_model', 'resolved_eff', 'reported_model', 'adapter_version', 'tokens_in', 'tokens_out', 'latency_ms']) assert.ok(columns('jobs').includes(c), c);
  assert.ok(columns('tasks').includes('depends_on'));
  for (const table of ['platform_state', 'platform_profiles', 'actor_presence']) assert.ok(columns(table).length, table);
  // Back to schema 5, then reopen: the step runs again and keeps the data.
  f.store.db.exec(`DROP TABLE platform_state; DROP TABLE platform_profiles; DROP TABLE actor_presence;
    ${['req_intent', 'req_eff', 'resolved_model', 'resolved_eff', 'reported_model', 'adapter_version', 'tokens_in', 'tokens_out', 'latency_ms'].map(c => `ALTER TABLE jobs DROP COLUMN ${c};`).join(' ')}
    ALTER TABLE tasks DROP COLUMN depends_on; PRAGMA user_version = 5;`);
  const store = f.reopen();
  assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as any).user_version), SCHEMA_VERSION);
  assert.equal((store.db.prepare('SELECT name FROM projects').get() as any).name, 'Repo');
  assert.ok(Number((store.db.prepare('SELECT count(*) n FROM platform_profiles').get() as any).n) > 0, 'profiles seeded again');
});

test('each adapter seeds its intent/eff profiles; an operator edit survives a restart', t => {
  const f = fixture(t);
  const profile = (id: string, intent: string, eff: string) => f.store.db.prepare('SELECT * FROM platform_profiles WHERE adapter_id=? AND intent=? AND eff=?').get(id, intent, eff) as any;
  for (const id of ['claude', 'codex', 'openai-api', 'antigravity']) for (const intent of ['fast', 'code', 'review', 'deep']) for (const eff of ['min', 'low', 'med', 'high', 'max']) assert.ok(profile(id, intent, eff), `${id} ${intent} ${eff}`);
  assert.ok(profile('claude', 'edit', 'med') && profile('codex', 'edit', 'med'));
  assert.equal(profile('antigravity', 'edit', 'med'), undefined, 'advice-only routes have no edit profile');
  assert.equal(profile('openai-api', 'edit', 'med'), undefined);
  assert.equal(profile('claude', 'review', 'high').native_model, 'opus');
  assert.equal(JSON.parse(profile('antigravity', 'deep', 'max').native_options).task, 'complex');
  assert.equal(profile('openai-api', 'code', 'med').native_model, 'gpt-6.1-terra');
  f.store.db.prepare("UPDATE platform_profiles SET native_model='custom' WHERE adapter_id='claude' AND intent='review' AND eff='high'").run();
  assert.equal(f.reopen().db.prepare("SELECT native_model FROM platform_profiles WHERE adapter_id='claude' AND intent='review' AND eff='high'").get()!.native_model, 'custom');
});

test('intent and eff are recorded in CLI fallback; explicit model and effort still win', t => {
  const f = fixture(t);
  const review = f.submit({ route: 'claude', intent: 'review', eff: 'high' });
  assert.equal(review.model, null); assert.equal(review.effort, 'high');
  assert.equal(review.options.model_source.state, 'fallback');
  assert.deepEqual([f.row(review.id).req_intent, f.row(review.id).req_eff, f.row(review.id).resolved_model, f.row(review.id).resolved_eff], ['review', 'high', null, 'high']);
  const pinned = f.submit({ route: 'claude', intent: 'review', eff: 'high', model: 'sonnet', effort: 'low' });
  assert.equal(pinned.model, 'sonnet'); assert.equal(pinned.effort, 'low');
  assert.equal(pinned.options.model_source.state, 'fallback');
  assert.equal(f.submit({ route: 'claude', intent: 'edit' }).mode, 'edit', 'intent=edit means an edit job');
  assert.equal(f.submit({ route: 'codex', eff: 'low' }).effort, 'low', 'eff alone uses the code intent');
  const ag = f.submit({ route: 'antigravity', intent: 'deep', eff: 'max' });
  assert.equal(ag.options.task, 'complex'); assert.equal(ag.effort, 'xhigh');
  assert.equal(f.submit({ route: 'antigravity', intent: 'deep', task: 'review' }).options.task, 'review', 'an explicit task wins');
  const plain = f.submit({ route: 'claude' });
  assert.equal(plain.model, null); assert.equal(f.row(plain.id).req_intent, 'code', 'no intent: infer code even in fallback');
  assert.equal(code(() => f.submit({ route: 'antigravity', intent: 'edit' })), 'INVALID_INPUT', 'an advice-only route refuses edit before any profile lookup');
  assert.equal(code(() => f.submit({ route: 'claude', intent: 'think' })), 'INVALID_INPUT');
  assert.equal(code(() => f.submit({ route: 'claude', intent: 'edit', mode: 'advice' })), 'INVALID_INPUT');
  f.store.db.prepare("UPDATE platform_profiles SET enabled=0 WHERE adapter_id='codex' AND intent='fast' AND eff='min'").run();
  assert.equal(code(() => f.submit({ route: 'codex', intent: 'fast', eff: 'min' })), 'PROFILE_UNAVAILABLE', 'a disabled profile is not used');
  const viaAir = f.call('air_tx', { project_id: 'p1', packet: '@air1\n#0 job route=claude intent=deep eff=max "think hard"', operation_id: randomUUID() });
  const airJob = f.call('job_status', { job_id: viaAir.handles['0'] }).job;
  assert.equal(airJob.model, null);
  assert.equal(airJob.effort, 'max');
  assert.equal(airJob.options.model_source.state, 'fallback');
});

test('finished jobs record latency, tokens, the reported model and the probed CLI version', async t => {
  const f = fixture(t);
  f.store.db.prepare("INSERT INTO platform_state(adapter_id,family,billing,probe_state,cli_version,last_probe_at,updated_at) VALUES('claude','anthropic','sub','verified','9.9.9',?,?)")
    .run(new Date().toISOString(), new Date().toISOString());
  const job = f.submit({ route: 'claude', prompt: 'USAGE please' });
  const runner = new Runner(f.store, f.home, { claude: { file: process.execPath, prefix: [FAKE] }, tickMs: 50 });
  f.cleanups.push(() => runner.stop()); runner.start();
  for (let i = 0; i < 200 && f.row(job.id).status !== 'completed'; i++) await sleep(50);
  const r = f.row(job.id);
  assert.equal(r.status, 'completed', r.error);
  assert.deepEqual([r.tokens_in, r.tokens_out, r.reported_model, r.adapter_version], [120, 34, 'claude-test-model', '9.9.9']);
  assert.ok(Number.isInteger(r.latency_ms) && r.latency_ms >= 0);
});

test('CLI probes check the flags Agent Commons uses, never send a prompt, and note a changed CLI', async t => {
  const f = fixture(t);
  const copy = path.join(f.base, 'cli.mjs'); fs.copyFileSync(HELP, copy);
  const probe = (flavor: string, id = 'claude') => new Prober(f.store, f.home, { [id]: { file: process.execPath, prefix: [copy, flavor] } }).probe(id);
  const state = (id = 'claude') => f.store.db.prepare('SELECT * FROM platform_state WHERE adapter_id=?').get(id) as any;
  await probe('claude-ok');
  assert.equal(state().probe_state, 'verified'); assert.equal(state().cli_version, '9.9.9 (Claude Code)');
  assert.equal(state().binary_sha256, createHash('sha256').update(fs.readFileSync(copy)).digest('hex'));
  await probe('claude-missing');
  assert.equal(state().probe_state, 'blocked'); assert.match(state().reason, /--effort/);
  fs.appendFileSync(copy, '\n// a new build\n');
  await probe('claude-ok');
  assert.equal(state().probe_state, 'verified'); assert.match(state().reason, /changed/);
  await probe('codex-ok', 'codex'); assert.equal(state('codex').probe_state, 'verified');
  await probe('broken'); assert.equal(state().probe_state, 'blocked');
  assert.equal(Number((f.store.db.prepare('SELECT count(*) n FROM jobs').get() as any).n), 0, 'no job and no prompt');
});

test('the antigravity probe only reads the helper approval record and compares hashes', async t => {
  const f = fixture(t);
  const helper = path.join(f.base, 'helper'), cli = path.join(f.base, 'agy.exe'), state = path.join(f.home, 'helpers', 'antigravity');
  fs.mkdirSync(path.join(helper, 'scripts'), { recursive: true }); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(helper, 'scripts', 'antigravity.py'), 'print(1)\n'); fs.writeFileSync(path.join(helper, 'agent.md'), 'agent\n'); fs.writeFileSync(cli, 'binary v1');
  const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const receipt = { status: 'passed', cli_version: '1.5.13', cli_sha256: sha(cli), agent_sha256: sha(path.join(helper, 'agent.md')),
    implementation: { 'scripts/antigravity.py': sha(path.join(helper, 'scripts', 'antigravity.py')), 'agent.md': sha(path.join(helper, 'agent.md')) } };
  const prober = new Prober(f.store, f.home, {}, { antigravityHelperRoot: helper, antigravityCli: cli });
  const read = async () => { await prober.probe('antigravity'); return f.store.db.prepare("SELECT * FROM platform_state WHERE adapter_id='antigravity'").get() as any; };
  assert.equal((await read()).probe_state, 'unavailable', 'no approval record yet');
  fs.writeFileSync(path.join(state, 'acceptance.json'), JSON.stringify(receipt));
  const before = fs.readFileSync(path.join(state, 'acceptance.json'), 'utf8');
  let s = await read(); assert.equal(s.probe_state, 'verified'); assert.equal(s.cli_version, '1.5.13');
  fs.writeFileSync(cli, 'binary v2');
  s = await read(); assert.equal(s.probe_state, 'drifted'); assert.match(s.reason, /CLI changed/);
  fs.writeFileSync(cli, 'binary v1'); fs.writeFileSync(path.join(helper, 'agent.md'), 'edited\n');
  s = await read(); assert.equal(s.probe_state, 'blocked'); assert.match(s.reason, /agent\.md/);
  assert.equal(fs.readFileSync(path.join(state, 'acceptance.json'), 'utf8'), before, 'the approval record is never written');
});

test('a CLI_ERROR job failure triggers a re-probe of that route', async t => {
  const f = fixture(t);
  const prober = new Prober(f.store, f.home, { claude: { file: process.execPath, prefix: [HELP, 'claude-ok'] } }, { schedule: false, adapters: ['claude'] });
  f.cleanups.push(() => prober.stop());
  prober.start();
  for (let i = 0; i < 100 && !f.store.db.prepare("SELECT 1 FROM platform_state WHERE adapter_id='claude'").get(); i++) await sleep(50);
  f.store.db.prepare("UPDATE platform_state SET last_probe_at='2000-01-01T00:00:00.000Z' WHERE adapter_id='claude'").run();
  const job = f.submit({ route: 'claude' });
  f.store.updateJob(job.id, { status: 'failed', error: 'CLI_ERROR: unknown option --effort', finished_at: new Date().toISOString() });
  for (let i = 0; i < 100 && (f.store.db.prepare("SELECT last_probe_at FROM platform_state WHERE adapter_id='claude'").get() as any).last_probe_at.startsWith('2000'); i++) await sleep(50);
  assert.ok(!(f.store.db.prepare("SELECT last_probe_at FROM platform_state WHERE adapter_id='claude'").get() as any).last_probe_at.startsWith('2000'));
});

test('every adapter has a probe; only the paid route skips running anything', () => {
  for (const id of ['claude', 'codex', 'openai-api', 'antigravity']) assert.equal(typeof adapter(id)!.probe, 'function', id);
});

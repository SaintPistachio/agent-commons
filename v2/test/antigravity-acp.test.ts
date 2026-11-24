import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { antigravity } from '../src/adapters/antigravity.ts';
import { Prober } from '../src/prober.ts';
import { Runner } from '../src/runner.ts';
import { Store, type Actor } from './fixtures/service.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const FINAL = ['completed', 'failed', 'needs_review', 'cancelled'];

function writeFakeAcpServer(dir: string): string {
  const script = path.join(dir, 'fake-acp.mjs');
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    import path from 'node:path';
    import readline from 'node:readline';

    const mode = process.env.FAKE_ACP_MODE || 'ok';
    const logFile = process.env.FAKE_ACP_LOG;
    const record = (entry) => {
      if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + '\\n');
    };
    record({
      argv: process.argv.slice(2),
      hasSecrets: {
        GEMINI_API_KEY: 'GEMINI_API_KEY' in process.env,
        GOOGLE_API_KEY: 'GOOGLE_API_KEY' in process.env,
        OPENAI_API_KEY: 'OPENAI_API_KEY' in process.env,
        ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' in process.env,
        AGY_ACP_CCPA_PROJECT: 'AGY_ACP_CCPA_PROJECT' in process.env,
        BROWSER: 'BROWSER' in process.env,
      },
    });

    const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
    let currentModel = 'gemini-4-neon';
    let currentEffort = 'high';
    let currentMode = 'default';
    let pendingToolPermId = 100;
    const rl = readline.createInterface({ input: process.stdin });

    rl.on('line', line => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        return send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.16' },
            agentCapabilities: { loadSession: true },
          },
        });
      }
      if (msg.method === 'session/new') {
        if (mode === 'auth-error') {
          return send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'Authentication required' },
          });
        }
        return send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: '11111111-1111-4111-8111-111111111111',
            _meta: { antigravity: { tier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } },
            models: {
              currentModelId: 'gemini-4-neon-high',
              availableModels: [
                { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
                { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
                { modelId: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' },
                { modelId: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)' },
                { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
                { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
              ],
            },
            modes: {
              currentModeId: 'default',
              availableModes: [
                { id: 'default', name: 'Default' },
                { id: 'accept-edits', name: 'Accept edits' },
                { id: 'plan', name: 'Plan' },
              ],
            },
            configOptions: [
              {
                id: 'model',
                currentValue: currentModel,
                options: [
                  { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
                  { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
                  { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
                  { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
                  { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
                ],
              },
              {
                id: 'thought_level',
                currentValue: currentEffort,
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                  { value: 'high', name: 'High' },
                  { value: 'xhigh', name: 'Extra' },
                ],
              },
              {
                id: 'mode',
                currentValue: currentMode,
                options: [
                  { value: 'default', name: 'Default' },
                  { value: 'accept-edits', name: 'Accept edits' },
                  { value: 'plan', name: 'Plan' },
                ],
              },
            ],
          },
        });
      }
      if (msg.method === 'session/set_config_option') {
        const { configId, value } = msg.params || {};
        record({ setConfig: { configId, value } });
        if (configId === 'model') currentModel = value;
        if (configId === 'thought_level') currentEffort = value;
        if (configId === 'mode') currentMode = value;
        return send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } });
      }
      if (msg.method === 'session/prompt') {
        const text = msg.params?.prompt?.[0]?.text ?? '';
        record({ prompt: text, model: currentModel, effort: currentEffort, mode: currentMode });
        if (text === 'QUOTA') {
          return send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32002, message: 'Gemini 4 Argon weekly limit reached; quota exhausted' },
          });
        }
        if (text === 'CRASH_MID_TURN') {
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial...' } } },
          });
          setTimeout(() => process.exit(2), 20);
          return;
        }
        if (text === 'SLEEP_CANCEL') {
          // Wait for session/cancel notification or process kill.
          return;
        }
        if (text === 'PERMISSION_TEST') {
          const toolPermId = pendingToolPermId++;
          const askPermId = pendingToolPermId++;
          const fsWriteId = pendingToolPermId++;
          send({
            jsonrpc: '2.0',
            id: toolPermId,
            method: 'session/request_permission',
            params: {
              sessionId: msg.params.sessionId,
              toolCall: { toolCallId: 'call_write_1', title: 'Write file' },
              options: [
                { optionId: 'opt_allow', kind: 'allow_once', name: 'Allow' },
                { optionId: 'opt_reject', kind: 'reject_once', name: 'Reject' },
              ],
            },
          });
          send({
            jsonrpc: '2.0',
            id: askPermId,
            method: 'session/request_permission',
            params: {
              sessionId: msg.params.sessionId,
              toolCall: { toolCallId: 'interaction_q1', title: 'Question' },
              options: [{ optionId: 'opt_yes', kind: 'allow_once', name: 'Yes' }],
            },
          });
          send({
            jsonrpc: '2.0',
            id: fsWriteId,
            method: 'fs/write_text_file',
            params: { path: 'x.txt', content: 'nope' },
          });
          // Store prompt id and emit completion after client replies arrive.
          globalThis.__pendingPrompt = msg;
          return;
        }
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'usage_update', usage: { inputTokens: 12, outputTokens: 34 } } },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'acp: ' } } },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text } } },
        });
        return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
      if (msg.method === 'session/cancel') {
        record({ cancelled: true });
        return;
      }
      if (msg.method === 'session/close') {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
        setTimeout(() => process.exit(0), 10);
        return;
      }
      // Responses to server-initiated requests during PERMISSION_TEST
      if (typeof msg.id === 'number' && msg.id >= 100) {
        record({ clientReply: msg });
        globalThis.__permReplies = (globalThis.__permReplies || 0) + 1;
        if (globalThis.__permReplies === 3 && globalThis.__pendingPrompt) {
          const p = globalThis.__pendingPrompt;
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: p.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'read-only ok' } } },
          });
          send({ jsonrpc: '2.0', id: p.id, result: { stopReason: 'end_turn' } });
        }
      }
    });
  `);
  return script;
}

function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-ag-acp-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'repo');
  fs.mkdirSync(root, { recursive: true });
  const script = writeFakeAcpServer(base);
  const logFile = path.join(base, 'acp-log.jsonl');
  const store = new Store(home);
  const actor: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  store.setActorTags(actor.id, 'anthropic', null);
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call('project_create', { name: 'Repo', root, operation_id: randomUUID() }).project;
  const acpCmd = { file: process.execPath, prefix: [script] };

  const runners: Runner[] = [];
  const makeRunner = () => {
    const r = new Runner(store, home, { antigravityAcp: acpCmd, tickMs: 25 });
    runners.push(r);
    return r;
  };

  const submit = (prompt: string, extra: Record<string, unknown> = {}) =>
    call('job_submit', { project_id: project.id, prompt, route: 'antigravity', operation_id: randomUUID(), ...extra }).job;

  const until = async (id: string, statuses: string[], ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const job = call('job_status', { job_id: id }).job;
      if (statuses.includes(job.status)) return job;
      if (Date.now() > end) throw new Error(`job ${id} stuck in ${job.status}`);
      await sleep(30);
    }
  };

  const readLog = () => fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
    : [];

  t.after(() => {
    for (const r of runners) r.stop();
    store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  return { base, home, root, script, logFile, store, actor, call, project, acpCmd, makeRunner, submit, until, readLog };
}

test('Antigravity ACP probe verifies server version/hash and reports auth-required failures as blocked', async t => {
  const f = fixture(t);
  const prober = new Prober(f.store, f.home, {}, { adapters: ['antigravity'], antigravityAcp: f.acpCmd, schedule: false });
  t.after(() => prober.stop());

  await prober.probe('antigravity');
  const state = f.store.platformState('antigravity')!;
  const expectedSha = createHash('sha256').update(fs.readFileSync(f.script)).digest('hex');
  assert.equal(state.probe_state, 'verified');
  assert.equal(state.cli_version, '1.5.16');
  assert.equal(state.binary_sha256, expectedSha);

  const prevMode = process.env.FAKE_ACP_MODE;
  process.env.FAKE_ACP_MODE = 'auth-error';
  t.after(() => {
    if (prevMode === undefined) delete process.env.FAKE_ACP_MODE;
    else process.env.FAKE_ACP_MODE = prevMode;
  });
  const blocked = await antigravity.probe({ home: f.home, options: {}, overrides: { antigravityAcp: f.acpCmd } });
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.reason ?? '', /Google sign-in/i);
});

test('Antigravity ACP discovery writes acp-catalog.json, marks hidden models, and updates discoverySummary', async t => {
  const f = fixture(t);
  const rows = await antigravity.discover!({ home: f.home, options: {}, overrides: { antigravityAcp: f.acpCmd } });
  assert.equal(rows.length, 6);
  assert.ok(rows.completeSources?.includes('acp-catalog'));
  assert.equal(rows.find(r => r.model === 'gemini-4-neon-high')?.hidden, false);
  assert.equal(rows.find(r => r.model === 'gemini-4-neon-high')?.state, 'validated');
  assert.equal(rows.find(r => r.model === 'claude-sonnet-5-5-high')?.hidden, false);
  assert.equal(rows.find(r => r.model === 'claude-sonnet-5-5-high')?.state, 'discovered');
  assert.equal(rows.find(r => r.model === 'gpt-oss-120b-medium')?.hidden, true);
  assert.equal(rows.find(r => r.model === 'gemini-pro-orchestrator-neon')?.hidden, true);

  const summary = antigravity.discoverySummary!({ home: f.home, options: {}, overrides: {} });
  assert.match(summary, /Antigravity ACP catalog current \(1\.5\.16, Google AI Pro\)/);
  assert.match(summary, /6 models/);
});

test('Antigravity ACP advice job sets config, assembles chunks, scrubs secrets, and validates model', async t => {
  const f = fixture(t);
  const prevEnv = {
    FAKE_ACP_LOG: process.env.FAKE_ACP_LOG,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AGY_ACP_CCPA_PROJECT: process.env.AGY_ACP_CCPA_PROJECT,
    BROWSER: process.env.BROWSER,
  };
  f.store.recordDiscovery(
    'antigravity',
    await antigravity.discover!({ home: f.home, options: {}, overrides: { antigravityAcp: f.acpCmd } }),
  );
  process.env.FAKE_ACP_LOG = f.logFile;
  process.env.GEMINI_API_KEY = 'AIzaSy' + 'FakeTestSecretValue123456789012345';
  process.env.GOOGLE_API_KEY = 'AIzaSy' + 'FakeGoogleKeyValue123456789012345';
  process.env.OPENAI_API_KEY = 'sk-' + 'testfakekeyvalue12345678901234567890';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-' + 'testfakekeyvalue12345678901234';
  process.env.AGY_ACP_CCPA_PROJECT = 'hijack';
  process.env.BROWSER = 'echo';
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  f.makeRunner().start();
  const job = f.submit('Explain this', { model: 'gemini-4-hydrogen-low', effort: 'low' });
  const done = await f.until(job.id, FINAL);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.result, 'acp: Explain this');
  assert.equal(done.reported_model, 'gemini-4-hydrogen-low');
  assert.equal(done.tokens_in, 12);
  assert.equal(done.tokens_out, 34);
  assert.equal(done.options.effective_family, 'google');

  const log = f.readLog();
  assert.deepEqual(log[0].hasSecrets, {
    GEMINI_API_KEY: false,
    GOOGLE_API_KEY: false,
    OPENAI_API_KEY: false,
    ANTHROPIC_API_KEY: false,
    AGY_ACP_CCPA_PROJECT: false,
    BROWSER: false,
  });
  assert.ok(log[0].argv.includes('--sandbox'));
  assert.ok(log[0].argv.includes('--include-default-customizations=false'));
  assert.deepEqual(
    log.filter((e: any) => e.setConfig).map((e: any) => e.setConfig),
    [
      { configId: 'mode', value: 'plan' },
      { configId: 'model', value: 'gemini-4-hydrogen' },
      { configId: 'thought_level', value: 'low' },
    ],
  );
  assert.equal(f.store.routeModels('antigravity').find(m => m.model === 'gemini-4-hydrogen-low')?.state, 'validated');
});

test('Antigravity ACP denies permissions and write requests in read-only advice mode', async t => {
  const f = fixture(t);
  const prevLog = process.env.FAKE_ACP_LOG;
  process.env.FAKE_ACP_LOG = f.logFile;
  t.after(() => {
    if (prevLog === undefined) delete process.env.FAKE_ACP_LOG;
    else process.env.FAKE_ACP_LOG = prevLog;
  });

  f.makeRunner().start();
  const job = f.submit('PERMISSION_TEST', { model: 'gemini-4-neon-high' });
  const done = await f.until(job.id, FINAL);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.result, 'read-only ok');

  const replies = f.readLog().filter((e: any) => e.clientReply).map((e: any) => e.clientReply);
  assert.equal(replies.length, 3);
  assert.deepEqual(replies[0].result, { outcome: { outcome: 'selected', optionId: 'opt_reject' } });
  assert.deepEqual(replies[1].result, { outcome: { outcome: 'cancelled' } });
  assert.equal(replies[2].error.code, -32601);
});

test('Antigravity ACP distinguishes pre-submission, quota, and mid-prompt failures', async t => {
  const f = fixture(t);
  f.makeRunner().start();

  // 1. Unavailable model fails before session/prompt
  const badModel = f.submit('Check', { model: 'nonexistent-model-high' });
  const mDone = await f.until(badModel.id, FINAL);
  assert.equal(mDone.status, 'failed');
  assert.match(mDone.error ?? '', /^MODEL_UNAVAILABLE:/);

  // 2. Quota failure on prompt records exhaustion and fails
  const quota = f.submit('QUOTA', { model: 'gemini-4-argon-medium' });
  const qDone = await f.until(quota.id, FINAL);
  assert.equal(qDone.status, 'failed');
  assert.match(qDone.error ?? '', /^(AG_POOL_EXHAUSTED|QUOTA_EXHAUSTED):/);
  assert.ok(f.store.usageFor('antigravity').some(u => u.pool === 'Gemini 4 Argon' && u.remaining_percent === 0));

  // 3. Crash after session/prompt goes to needs_review
  const crash = f.submit('CRASH_MID_TURN', { model: 'gemini-4-neon-high' });
  const cDone = await f.until(crash.id, FINAL);
  assert.equal(cDone.status, 'needs_review');
  assert.match(cDone.error ?? '', /never replayed/);

  // 4. Cancel after session/prompt goes to needs_review
  const slow = f.submit('SLEEP_CANCEL', { model: 'gemini-4-neon-high' });
  await f.until(slow.id, ['running']);
  await sleep(200);
  f.call('job_cancel', { job_id: slow.id, operation_id: randomUUID() });
  const sDone = await f.until(slow.id, FINAL);
  assert.equal(sDone.status, 'needs_review');
  assert.match(sDone.error ?? '', /^CANCELLED/);
});

test('Antigravity ACP review steers away from the caller family (anthropic)', async t => {
  const f = fixture(t);
  const prevLog = process.env.FAKE_ACP_LOG;
  process.env.FAKE_ACP_LOG = f.logFile;
  t.after(() => {
    if (prevLog === undefined) delete process.env.FAKE_ACP_LOG;
    else process.env.FAKE_ACP_LOG = prevLog;
  });

  const task = f.call('task_create', { project_id: f.project.id, title: 'Review me', operation_id: randomUUID() }).task;
  const job = f.submit('Review this change', {
    task_id: task.id,
    task: 'review',
    effort: 'high',
  });
  f.store.annotateJob(job.id, { review_for: f.actor.id });
  f.makeRunner().start();
  const done = await f.until(job.id, FINAL);
  assert.equal(done.status, 'completed', done.error);
  assert.ok(!String(done.reported_model).startsWith('claude-'), `unexpected model ${done.reported_model}`);
  assert.notEqual(done.options.effective_family, 'anthropic');
});

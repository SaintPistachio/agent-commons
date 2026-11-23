import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './fixtures/service.ts';
import { Runner } from '../src/runner.ts';
import { adapter } from '../src/adapters/registry.ts';
import { parsePacket } from '../src/air/parser.ts';
import { AIR_PATCH_PRIMER } from '../src/air/primer.ts';

function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-context-diet-'));
  const home = path.join(base, 'home'), root = path.join(base, 'repo'), sub = path.join(root, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'notes.txt'), 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(path.join(sub, 'more.txt'), 'extra context\n');
  const store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(base, { recursive: true, force: true }); });
  const actor = store.createActor('diet-tester', 'participant', 'diet-tester').actor;
  for (const id of ['claude', 'codex', 'openai-api']) store.recordProbe(adapter(id)!.capabilities, { state: 'verified' });
  const call = (method: string, input: Record<string, unknown>) =>
    store.call(actor, method, { operation_id: randomUUID(), ...input });
  const project = call('project_create', { name: 'Repo', root }).project;
  const submit = (extra: Record<string, unknown> = {}) => call('job_submit', {
    project_id: project.id, route: 'claude', cwd: sub, protocol: 'air', prompt: 'Review the notes', ...extra,
  }).job;
  const finish = (id: string, result: string) =>
    store.updateJob(id, { status: 'completed', result, finished_at: new Date().toISOString() });
  const job = (id: string) => store.jobByRef(id);
  const artifact = (id: string) => call('artifact_read', { artifact_id: id }).content as string;
  const line = (id: string) => call('air_get', { handles: store.handleOf('j', id) }).air as string;
  return { store, home, root, sub, project, call, submit, finish, job, artifact, line };
}

test('AIR accepts cwd on jobs and room steps and unquoted range and grep selectors', t => {
  const f = fixture(t);
  const refs = ['file:notes.txt:1-1+3-3', 'grep:notes.txt:alpha|gamma:0'];
  const fields = `cwd=${JSON.stringify(f.sub)} ctx=${refs.join(',')}`;
  const room = parsePacket(`@air1\n#0 rstep g=g1 ${fields} "Review"`).nodes[0];
  assert.deepEqual(room.fields.cwd, [{ text: f.sub }]);
  assert.deepEqual(room.fields.ctx, refs.map(text => ({ text })));
  const tx = f.call('air_tx', { project_id: f.project.id, packet: `@air1\n#0 job route=claude ${fields} "Review"` });
  const job = f.job(tx.handles['0']);
  assert.equal(job.options.cwd, fs.realpathSync(f.sub));
  assert.deepEqual(job.options.ctx, refs);
  assert.match(f.artifact(job.options.ctx_artifact), /@ctx file:notes\.txt:1-1\+3-3 lines=1-1,3-3/);
  assert.match(f.artifact(job.options.ctx_artifact), /1\|alpha[\s\S]*3\|gamma/);
});

test('patch protocol adds its primer and records proposal counts without applying the proposal', t => {
  const f = fixture(t);
  const job = f.submit({ protocol: 'patch', context_refs: ['file:notes.txt'] });
  const prompt = new Runner(f.store, f.home)['workerPrompt'](f.job(job.id));
  assert.ok(prompt.startsWith(AIR_PATCH_PRIMER + '\n\n===DATA-'));
  assert.match(prompt, /^[\s\S]*\n\n===DATA-([0-9a-f]{32})===\n@ctx [\s\S]*\n===END-DATA-\1===\n\n@request\nReview the notes$/);
  const result = [
    '<<<EDIT notes.txt', '<<<OLD', 'alpha', '>>>NEW', 'updated', '>>>END',
    '<<<FILE new.txt', 'new', '>>>END',
    '<<<DELETE more.txt', '>>>END',
    '@air1', '#0 chk "Patch proposed"',
  ].join('\n');
  f.finish(job.id, result);
  assert.deepEqual(f.job(job.id).options.patch, { edits: 1, files: 1, deletes: 1 });
  assert.equal(f.job(job.id).options.air.summary, 'Patch proposed');
  assert.match(f.line(job.id), / patch=1e\/1f\/1d\b/);
  assert.equal(fs.readFileSync(path.join(f.sub, 'notes.txt'), 'utf8'), 'alpha\nbeta\ngamma\n');
  assert.ok(!fs.existsSync(path.join(f.sub, 'new.txt')));
  assert.ok(fs.existsSync(path.join(f.sub, 'more.txt')));
});

test('need to=ctx deduplicates refs and resumes a patch job directly at most twice', t => {
  const f = fixture(t);
  const original = f.submit({ protocol: 'patch', context_refs: ['file:notes.txt'] });
  const need = '@air1\n#0 need to=ctx ctx=file:notes.txt,file:more.txt "Read the additional notes"';
  let current = original;
  for (let i = 1; i <= 2; i++) {
    f.finish(current.id, need);
    const saved = f.job(current.id);
    const handle = f.store.handleOf('a', saved.options.need_ctx_artifact);
    assert.match(f.artifact(saved.options.need_ctx_artifact), /extra context/);
    assert.ok(f.line(current.id).includes(` need_ctx=${handle}`));
    current = f.job(saved.options.next);
    assert.deepEqual([current.trigger, current.wake_depth, current.parent_job_id, current.options.proto, current.options.yields],
      ['resume', 0, original.id, 'patch', i]);
    assert.equal(current.options.cwd, fs.realpathSync(f.sub));
    assert.equal(current.route, original.route);
    assert.deepEqual(current.options.ctx, ['file:notes.txt', 'file:more.txt']);
    assert.match(f.artifact(current.options.ctx_artifact), /extra context/);
    assert.ok(current.prompt.includes(`@ctx_resolved ${handle} (2 refs):`));
  }
  f.finish(current.id, need);
  assert.equal(f.job(current.id).options.need_refused, 'MAX_YIELDS');
  assert.ok(f.job(current.id).options.need_ctx_artifact);
  assert.equal(f.job(current.id).options.next, undefined);
  assert.equal((f.store.db.prepare('SELECT count(*) n FROM jobs').get() as { n: number }).n, 3);
});

test('paid local needs save context, do not resume, and do not echo the artifact in the creator delta', t => {
  const f = fixture(t);
  const paid = { route: 'openai-api', max_cost_usd: '0.05', purpose: 'review', deliverable: 'notes' };
  const job = f.submit(paid);
  f.call('air_sync', { project_id: f.project.id });
  f.finish(job.id, '@air1\n#0 need to=ctx ctx=file:more.txt "Missing notes"');
  const opts = f.job(job.id).options, handle = f.store.handleOf('a', opts.need_ctx_artifact);
  assert.equal(opts.need_refused, 'PAID_ROUTE');
  assert.equal(opts.next, undefined);
  assert.match(f.artifact(opts.need_ctx_artifact), /extra context/);
  const delta = f.call('air_sync', { project_id: f.project.id }).air as string;
  assert.ok(f.line(job.id).includes(` need_ctx=${handle}`));
  assert.ok(!delta.split('\n').some(line => line.startsWith(`A ${handle} `)));

  const forbidden = f.submit(paid);
  f.finish(forbidden.id, '@air1\n#0 need to=ctx ctx=diff:HEAD~1..HEAD "Missing diff"');
  assert.equal(f.job(forbidden.id).options.need_refused, 'CTX_NOT_ALLOWED');
  assert.equal(f.job(forbidden.id).options.need_ctx_artifact, undefined);
});

test('local context needs reject empty, oversized and unsafe selections', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.sub, '.env'), 'PRIVATE=example\n');
  for (const [refs, code] of [
    ['', 'NO_CTX'],
    [` ctx=${Array.from({ length: 21 }, (_, i) => `file:${i}.txt`).join(',')}`, 'INVALID_INPUT'],
    [' ctx=file:.env', 'CTX_DENIED'],
  ]) {
    const job = f.submit();
    f.finish(job.id, `@air1\n#0 need to=ctx${refs} "Need context"`);
    const opts = f.job(job.id).options;
    assert.equal(opts.need_refused, code);
    assert.equal(opts.need_ctx_artifact, undefined);
    assert.equal(opts.next, undefined);
  }
});

test('a peer consult preserves the patch protocol and cwd when the original worker resumes', t => {
  const f = fixture(t);
  const parent = f.submit({ protocol: 'patch', context_refs: ['file:notes.txt'] });
  f.finish(parent.id, '@air1\n#0 need to=codex ctx=file:more.txt "Get a second opinion"');
  const consult = f.job(f.job(parent.id).options.next);
  assert.equal(consult.options.cwd, fs.realpathSync(f.sub));
  f.finish(consult.id, 'Consider a smaller change.');
  const resumed = f.job(f.job(consult.id).options.next);
  assert.equal(resumed.options.proto, 'patch');
  assert.equal(resumed.options.cwd, fs.realpathSync(f.sub));
  assert.deepEqual(resumed.options.ctx, ['file:notes.txt']);
  assert.match(resumed.prompt, /Consider a smaller change/);
});

import { parsePatchBlocks, applyPatchBlocks, buildRepairContext } from "../src/patch.ts";

test("op_room_step forwards cwd to seat jobs", t => {
  const f = fixture(t);
  const room = f.call("discussion_open", {
    project_id: f.project.id, subject: "Arch review", question: "Does cwd propagate?",
    seats: ["claude:med:arch", "codex:med:critic"], room_mode: "parallel", max_rounds: 2,
  }).discussion;
  const handle = f.store.handleOf("g", room.id);
  const tx = f.call("air_tx", {
    project_id: f.project.id,
    packet: `@air1\n#0 rstep g=${handle} cwd=${JSON.stringify(f.sub)} ctx=file:notes.txt "Round 1"`,
  });
  assert.match(tx.handles["0"], /^g\d+@r1\(j\d+,j\d+\)$/);
  const jobs = f.store.db.prepare("SELECT id FROM jobs WHERE room_id=? ORDER BY seq").all(room.id) as Array<{ id: string }>;
  assert.equal(jobs.length, 2);
  for (const row of jobs) {
    const j = f.job(row.id);
    assert.equal(j.options.cwd, fs.realpathSync(f.sub));
    assert.match(f.artifact(j.options.ctx_artifact), /alpha\nbeta\ngamma/);
  }
});

test("patch.ts applies chained edits, preserves CRLF, rolls back on mismatch unless allowPartial, and builds repair context", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac2-patch-unit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "crlf.ts"), "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n");
  fs.writeFileSync(path.join(dir, " gone.txt".trim()), "remove me\n");

  const patchText = [
    "<<<EDIT crlf.ts", "<<<OLD", "const a = 1;", ">>>NEW", "const a = 10;", ">>>END",
    "<<<EDIT crlf.ts", "<<<OLD", "const a = 10;\nconst b = 2;", ">>>NEW", "const a = 100;\nconst b = 200;", ">>>END",
    "<<<FILE sub/added.ts", "export const x = 42;", ">>>END",
    "<<<DELETE gone.txt", ">>>END",
  ].join("\n");
  const blocks = parsePatchBlocks(patchText);
  assert.equal(blocks.length, 4);

  const dry = applyPatchBlocks(dir, blocks, { dryRun: true });
  assert.equal(dry.applied, 4);
  assert.equal(dry.rejected.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, "crlf.ts"), "utf8"), "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n");

  const applied = applyPatchBlocks(dir, blocks);
  assert.equal(applied.applied, 4);
  assert.equal(applied.rejected.length, 0);
  assert.equal(applied.files, 3);
  assert.equal(fs.readFileSync(path.join(dir, "crlf.ts"), "utf8"), "const a = 100;\r\nconst b = 200;\r\nconst c = 3;\r\n");
  assert.equal(fs.readFileSync(path.join(dir, "sub", "added.ts"), "utf8"), "export const x = 42;\n");
  assert.equal(fs.existsSync(path.join(dir, "gone.txt")), false);

  // Atomic rollback by default when one block mismatches
  const mixed = parsePatchBlocks([
    "<<<EDIT crlf.ts", "<<<OLD", "const c = 3;", ">>>NEW", "const c = 300;", ">>>END",
    "<<<EDIT crlf.ts", "<<<OLD", "const missing = 999;", ">>>NEW", "const missing = 0;", ">>>END",
  ].join("\n"));
  const rolledBack = applyPatchBlocks(dir, mixed);
  assert.equal(rolledBack.applied, 0);
  assert.equal(rolledBack.rejected.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "crlf.ts"), "utf8"), "const a = 100;\r\nconst b = 200;\r\nconst c = 3;\r\n");

  // allowPartial applies the valid block and returns the rejected block with a window
  const partial = applyPatchBlocks(dir, mixed, { allowPartial: true });
  assert.equal(partial.applied, 1);
  assert.equal(partial.rejected.length, 1);
  assert.match(partial.rejected[0].window ?? "", /1\|const a = 100;/);
  assert.equal(fs.readFileSync(path.join(dir, "crlf.ts"), "utf8"), "const a = 100;\r\nconst b = 200;\r\nconst c = 300;\r\n");

  // Refuses traversal and secret paths
  for (const badPath of ["../escape.ts", ".env", "config/secret.json"]) {
    const res = applyPatchBlocks(dir, parsePatchBlocks(`<<<FILE ${badPath}\nx\n>>>END`));
    assert.equal(res.applied, 0);
    assert.equal(res.rejected.length, 1);
  }

  // buildRepairContext includes rejected window, stack trace excerpt, and redacts secrets
  const stackFile = path.join(dir, "sub", "added.ts");
  const repair = buildRepairContext(dir, partial.rejected, {
    status: 1,
    stdout: `not ok 1 - test\n  Token ${"sk-" + "proj-" + "1234567890abcdefghijklmnop"}`,
    stderr: `Error: boom\n    at Object.<anonymous> (${stackFile}:1:1)`,
  });
  assert.match(repair, /Rejected: OLD text did not match/);
  assert.match(repair, /1\|export const x = 42;/);
  assert.doesNotMatch(repair, /sk-proj-/);
  assert.match(repair, /\[REDACTED\]/);
});

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer } from "./fixtures/service.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("cli.ts air-apply applies patches, runs --verify, and uploads repair_ctx on failure", async t => {
  const f = fixture(t);
  const { actor, token } = f.store.createActor("apply-cli", "participant", "apply-cli");
  const good = f.submit({ protocol: "patch" });
  f.finish(good.id, [
    "<<<EDIT notes.txt", "<<<OLD", "beta", ">>>NEW", "BETA", ">>>END",
    "<<<FILE created.txt", "created line", ">>>END",
    "@air1", "#0 chk \"ok\"",
  ].join("\n"));
  const bad = f.submit({ protocol: "patch" });
  f.finish(bad.id, [
    "<<<EDIT notes.txt", "<<<OLD", "nonexistent line", ">>>NEW", "x", ">>>END",
    "@air1", "#0 chk \"bad\"",
  ].join("\n"));
  const goodHandle = f.store.handleOf("j", good.id)!;
  const badHandle = f.store.handleOf("j", bad.id)!;
  f.store.close();

  const running = await startServer(f.home, 0, false);
  try {
    const conn = path.join(f.home, "apply-conn.json");
    fs.writeFileSync(conn, JSON.stringify({ url: running.url, token, actorId: actor.id, projectIds: [f.project.id], selectProject: false }));
    const runCli = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "air-apply", ...args, "--connection", conn],
        { cwd: f.sub, encoding: "utf8" }, (err, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout.trim(), stderr: stderr.trim() });
        });
    });

    const dry = await runCli("--handles", goodHandle, "--cwd", f.sub, "--dry-run");
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.equal(dry.stdout, `@air1 apply jobs=${goodHandle} applied=2 rejected=0 files=2 dry_run=1`);
    assert.equal(fs.existsSync(path.join(f.sub, "created.txt")), false);

    const ok = await runCli("--handles", goodHandle, "--cwd", f.sub, "--verify", `"${process.execPath}" -e "process.exit(0)"`);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(ok.stdout, `@air1 apply jobs=${goodHandle} applied=2 rejected=0 files=2 verify=ok`);
    assert.equal(fs.readFileSync(path.join(f.sub, "notes.txt"), "utf8"), "alpha\nBETA\ngamma\n");
    assert.equal(fs.readFileSync(path.join(f.sub, "created.txt"), "utf8"), "created line\n");

    const fail = await runCli("--handles", badHandle, "--cwd", f.sub);
    assert.equal(fail.code, 2, fail.stdout + fail.stderr);
    assert.match(fail.stdout, new RegExp(`^@air1 apply jobs=${badHandle} applied=0 rejected=1 files=0 repair_ctx=a\\d+$`));
    const repairHandle = /repair_ctx=(a\d+)/.exec(fail.stdout)![1];
    const repairText = running.store.call(actor, "air_get", { handles: repairHandle, raw: true }).raw[0].content;
    assert.match(repairText, /Rejected: OLD text did not match/);
    assert.match(repairText, /2\|BETA/);
  } finally {
    await running.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, CommonsError, type Actor } from './fixtures/service.ts';

function fixture(t: any) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-store-'));
  const home = path.join(workspace, 'data');
  const projectDirectory = path.join(workspace, 'repo');
  fs.mkdirSync(projectDirectory);
  let store = new Store(home);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(workspace, { recursive: true, force: true }); });
  const claude = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  const codex = store.createActor('codex-desktop', 'participant', 'codex-desktop').actor;
  const op = () => randomUUID();
  const call = (actor: Actor, method: string, input: Record<string, unknown> = {}) => store.call(actor, method, input);
  const project = call(claude, 'project_create', { name: 'Demo', root: projectDirectory, objective: 'Ship it', operation_id: op() }).project;
  return { home, projectDirectory, claude, codex, op, call, project, reopen: () => { store.close(); store = new Store(home); return store; }, get store() { return store; } };
}
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as CommonsError).code; } return 'NO_ERROR'; };

test('one app records work and another resumes it, including after a restart', t => {
  const f = fixture(t);
  const task = f.call(f.claude, 'task_create', { project_id: f.project.id, title: 'Fix parser', acceptance: ['tests pass'], operation_id: f.op() }).task;
  const claimed = f.call(f.claude, 'task_claim', { task_id: task.id, version: 1, operation_id: f.op() }).task;
  assert.equal(claimed.owner, 'claude-desktop'); assert.equal(claimed.status, 'in_progress'); assert.equal(claimed.version, 2);
  f.call(f.claude, 'decision_record', { project_id: f.project.id, task_id: task.id, summary: 'Use a table-driven parser', evidence: ['bench.txt'], operation_id: f.op() });
  f.call(f.claude, 'project_checkpoint', { project_id: f.project.id, summary: 'Parser half done', revision: 'abc123', next_action: 'Finish error cases', checks: ['unit: 12 pass'], operation_id: f.op() });
  f.call(f.claude, 'team_ask', { project_id: f.project.id, to: ['codex-desktop'], body: 'Can you review the lexer?', task_id: task.id, operation_id: f.op() });

  f.reopen();
  const brief = f.call(f.codex, 'project_resume', { project_id: f.project.id });
  assert.equal(brief.next_action, 'Finish error cases');
  assert.equal(brief.latest_checkpoint.revision, 'abc123');
  assert.deepEqual(brief.latest_checkpoint.checks, ['unit: 12 pass']);
  assert.equal(brief.active_tasks[0].id, task.id);
  assert.equal(brief.recent_decisions[0].summary, 'Use a table-driven parser');
  assert.equal(brief.inbox.length, 1); assert.equal(brief.inbox[0].body, 'Can you review the lexer?');
  const focused = f.call(f.codex, 'project_resume', { project_id: f.project.id, task_id: task.id });
  assert.equal(focused.task.owner, 'claude-desktop'); assert.equal(focused.decisions.length, 1);
  assert.deepEqual(f.call(f.codex, 'project_discover', { root: path.join(f.projectDirectory, 'sub', 'dir') }).projects.map((p: any) => p.id), [f.project.id]);
});

test('operation_id replays the stored result and rejects different input', t => {
  const f = fixture(t);
  const id = f.op(), input = { project_id: f.project.id, title: 'Once', operation_id: id };
  const first = f.call(f.claude, 'task_create', input);
  const again = f.call(f.claude, 'task_create', input);
  assert.equal(again.task.id, first.task.id); assert.equal(again.replayed, true);
  assert.equal(f.call(f.claude, 'project_status', { project_id: f.project.id }).task_counts.open, 1);
  assert.equal(code(() => f.call(f.claude, 'task_create', { ...input, title: 'Different' })), 'IDEMPOTENCY_CONFLICT');
  assert.equal(code(() => f.call(f.claude, 'task_create', { project_id: f.project.id, title: 'No op id' })), 'INVALID_INPUT');
});

test('ownership and versions are enforced', t => {
  const f = fixture(t);
  const task = f.call(f.claude, 'task_create', { project_id: f.project.id, title: 'Owned', operation_id: f.op() }).task;
  f.call(f.claude, 'task_claim', { task_id: task.id, version: 1, operation_id: f.op() });
  assert.equal(code(() => f.call(f.codex, 'task_claim', { task_id: task.id, version: 2, operation_id: f.op() })), 'TASK_OWNED');
  assert.equal(code(() => f.call(f.codex, 'task_update', { task_id: task.id, version: 2, status: 'done', operation_id: f.op() })), 'OWNER_REQUIRED');
  assert.equal(code(() => f.call(f.claude, 'task_update', { task_id: task.id, version: 1, status: 'done', operation_id: f.op() })), 'VERSION_CONFLICT');
  const released = f.call(f.claude, 'task_release', { task_id: task.id, version: 2, operation_id: f.op() }).task;
  assert.equal(released.owner, null); assert.equal(released.status, 'open');
  const taken = f.call(f.codex, 'task_claim', { task_id: task.id, version: 3, operation_id: f.op() }).task;
  const done = f.call(f.codex, 'task_update', { task_id: task.id, version: taken.version, status: 'done', next_action: null, operation_id: f.op() }).task;
  assert.equal(done.status, 'done');
  assert.equal(f.call(f.codex, 'project_resume', { project_id: f.project.id }).active_tasks.length, 0);
  assert.equal(code(() => f.call(f.claude, 'task_claim', { task_id: task.id, version: done.version, operation_id: f.op() })), 'TASK_CLOSED');
});

test('addressed questions leave the inbox once answered or acknowledged', t => {
  const f = fixture(t);
  const question = f.call(f.claude, 'team_ask', { project_id: f.project.id, to: ['codex-desktop'], body: 'Which branch?', operation_id: f.op() }).message;
  assert.equal(code(() => f.call(f.claude, 'team_reply', { message_id: question.id, body: 'self', operation_id: f.op() })), 'NOT_A_RECIPIENT');
  const reply = f.call(f.codex, 'team_reply', { message_id: question.id, body: 'main', operation_id: f.op() }).message;
  assert.equal(f.call(f.codex, 'team_inbox', { project_id: f.project.id }).messages.length, 0);
  const inbox = f.call(f.claude, 'team_inbox', { project_id: f.project.id }).messages;
  assert.equal(inbox.length, 1); assert.equal(inbox[0].reply_to, question.id);
  f.call(f.claude, 'team_ack', { message_id: reply.id, operation_id: f.op() });
  assert.equal(f.call(f.claude, 'team_inbox', { project_id: f.project.id }).messages.length, 0);
  assert.equal(code(() => f.call(f.claude, 'team_ask', { project_id: f.project.id, to: ['nobody'], body: 'x', operation_id: f.op() })), 'ACTOR_NOT_FOUND');
});

test('discussions have one owner and end in an outcome', t => {
  const f = fixture(t);
  const discussion = f.call(f.claude, 'discussion_open', { project_id: f.project.id, subject: 'Cache?', question: 'Should resume cache?', operation_id: f.op() }).discussion;
  const post = f.call(f.codex, 'discussion_post', { discussion_id: discussion.id, body: 'No, rows are small.', operation_id: f.op() }).message;
  f.call(f.claude, 'discussion_post', { discussion_id: discussion.id, body: 'Agreed.', reply_to: post.id, operation_id: f.op() });
  assert.equal(code(() => f.call(f.codex, 'discussion_close', { discussion_id: discussion.id, outcome: 'x', operation_id: f.op() })), 'OWNER_REQUIRED');
  f.call(f.claude, 'discussion_close', { discussion_id: discussion.id, outcome: 'Decision: no cache.', operation_id: f.op() });
  const read = f.call(f.codex, 'discussion_read', { discussion_id: discussion.id });
  assert.equal(read.discussion.status, 'closed'); assert.equal(read.messages.length, 2);
  assert.equal(code(() => f.call(f.codex, 'discussion_post', { discussion_id: discussion.id, body: 'late', operation_id: f.op() })), 'DISCUSSION_CLOSED');
});

test('artifacts are content-addressed and referenced by checkpoints', t => {
  const f = fixture(t);
  const artifact = f.call(f.claude, 'artifact_submit', { project_id: f.project.id, name: 'log', content: 'all green', operation_id: f.op() }).artifact;
  assert.equal(f.call(f.codex, 'artifact_read', { artifact_id: artifact.id }).content, 'all green');
  f.call(f.claude, 'project_checkpoint', { project_id: f.project.id, summary: 'with evidence', artifacts: [artifact.id], operation_id: f.op() });
  assert.equal(code(() => f.call(f.claude, 'project_checkpoint', { project_id: f.project.id, summary: 'bad', artifacts: ['missing'], operation_id: f.op() })), 'ARTIFACT_NOT_FOUND');
});

test('a task checkpoint does not replace the project overview next action', t => {
  const f = fixture(t);
  f.call(f.claude, 'project_checkpoint', { project_id: f.project.id, summary: 'Project state', next_action: 'Ship v2 delegation', operation_id: f.op() });
  const task = f.call(f.claude, 'task_create', { project_id: f.project.id, title: 'Side check', operation_id: f.op() }).task;
  f.call(f.claude, 'project_checkpoint', { project_id: f.project.id, task_id: task.id, summary: 'Side check state', next_action: 'Reply to Claude', operation_id: f.op() });
  const brief = f.call(f.codex, 'project_resume', { project_id: f.project.id });
  assert.equal(brief.next_action, 'Ship v2 delegation');
  assert.equal(brief.latest_checkpoint.summary, 'Project state');
  assert.equal(f.call(f.codex, 'project_resume', { project_id: f.project.id, task_id: task.id }).checkpoints[0].next_action, 'Reply to Claude');
});

test('unknown methods, bad tokens and duplicate roots are refused', t => {
  const f = fixture(t);
  assert.equal(code(() => f.call(f.claude, 'routing_select', {})), 'UNKNOWN_METHOD');
  assert.equal(code(() => f.store.authenticate('wrong')), 'UNAUTHENTICATED');
  assert.equal(code(() => f.call(f.claude, 'project_create', { name: 'Again', root: f.projectDirectory, operation_id: f.op() })), 'PROJECT_ROOT_EXISTS');
});

test('job_submit and job_status shorten long prompts unless asked; the runner still gets the whole prompt', t => {
  const f = fixture(t);
  const prompt = 'x'.repeat(2000);
  const job = f.call(f.claude, 'job_submit', { project_id: f.project.id, route: 'claude', prompt, operation_id: f.op() }).job;
  assert.equal(job.prompt_chars, 2000); assert.ok(job.prompt.length < 600);
  const brief = f.call(f.claude, 'job_status', { job_id: job.id }).job;
  assert.equal(brief.prompt_chars, 2000); assert.ok(brief.prompt.endsWith(' [...]'));
  assert.equal(f.call(f.claude, 'job_status', { job_id: job.id, include_prompt: true }).job.prompt, prompt);
  assert.equal(f.store.claimQueuedJob({ claude: 1 }, 2)!.prompt, prompt);
  assert.equal(f.call(f.claude, 'job_status', { job_id: f.call(f.claude, 'job_submit', { project_id: f.project.id, route: 'claude', prompt: 'short', operation_id: f.op() }).job.id }).job.prompt, 'short');
});

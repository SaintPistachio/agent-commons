/** MCP tool catalog. Names match v1 so existing instructions keep working. */
import { adapterIds } from './adapters/registry.ts';
import { INTENTS, EFFORTS } from './adapters/types.ts';
type Schema = Record<string, any>;
const str = (description?: string, maxLength = 65536): Schema => ({ type: 'string', minLength: 1, maxLength, ...(description ? { description } : {}) });
const strings = (description?: string): Schema => ({ type: 'array', items: { type: 'string', maxLength: 4096 }, maxItems: 200, ...(description ? { description } : {}) });
const dependencies: Schema = { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false,
  properties: { task_id: { type: 'string' }, kind: { type: 'string', enum: ['done', 'git'] } }, required: ['task_id', 'kind'] } };
const projectId = str('Project ID from project_discover. Defaults to the connection\'s single project when omitted.', 256);
const operationId = str('Stable ID for this mutation. Reuse it to retry safely; the stored result is returned.', 256);
const taskId = str('Task ID.', 256);
const ver = { type: 'integer', minimum: 1, description: 'Current task version (optimistic concurrency).' };
const reviewPolicyField = { type: 'string', enum: ['none', 'cross'], description: 'cross: moving the task to awaiting_review queues one review by another model family (subscription routes only).' };

interface Tool { name: string; description: string; properties: Schema; required?: string[] }
const tools: Tool[] = [
  { name: 'project_discover', description: 'List projects. Pass root (the current workspace path) to find the project for this workspace.',
    properties: { root: str('Workspace or repository path.', 4096), include_archived: { type: 'boolean', description: 'Also list archived projects.' } } },
  { name: 'project_create', description: 'Register a project for a workspace root.',
    properties: { name: str(undefined, 256), root: str('Workspace or repository path.', 4096), objective: str(), next_action: str(undefined, 4096), operation_id: operationId },
    required: ['name', 'operation_id'] },
  { name: 'project_resume', description: 'Read the project briefing: next action, latest checkpoint, active tasks, recent decisions, open discussions and your inbox. Pass task_id for a task-focused briefing. No inference.',
    properties: { project_id: projectId, task_id: taskId } },
  { name: 'project_status', description: 'Read project task counts.', properties: { project_id: projectId } },
  { name: 'project_checkpoint', description: 'Publish a checkpoint: summary, code revision/branch, checks run, open questions and next action.',
    properties: { project_id: projectId, task_id: taskId, revision: str('Git commit.', 256), branch: str(undefined, 256), summary: str(), next_action: str(undefined, 4096),
      checks: strings('Checks run and their results.'), open_questions: strings(), artifacts: strings('Artifact IDs.'),
      failed: { type: 'boolean', description: 'The checks failed. A second failed checkpoint in a row in the same scope returns consult_hint (idle peers of another model family).' }, operation_id: operationId },
    required: ['summary', 'operation_id'] },
  { name: 'task_create', description: 'Create a task with acceptance criteria.',
    properties: { project_id: projectId, title: str(undefined, 512), objective: str(), acceptance: strings(), next_action: str(undefined, 4096),
      review_policy: reviewPolicyField, depends_on: dependencies, operation_id: operationId },
    required: ['title', 'operation_id'] },
  { name: 'task_read', description: 'Read a task.', properties: { task_id: taskId }, required: ['task_id'] },
  { name: 'task_claim', description: 'Take ownership of an unowned task at its current version.',
    properties: { task_id: taskId, version: ver, operation_id: operationId }, required: ['task_id', 'version', 'operation_id'] },
  { name: 'task_update', description: 'Update a task you own: status (open, in_progress, blocked, awaiting_review, done, cancelled), next_action, title, objective, acceptance.',
    properties: { task_id: taskId, version: ver, status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'awaiting_review', 'done', 'cancelled'] },
      next_action: str(undefined, 4096), title: str(undefined, 512), objective: str(), acceptance: strings(), review_policy: reviewPolicyField,
      depends_on: dependencies, integrated_revision: { type: ['string', 'null'], maxLength: 64 }, operation_id: operationId },
    required: ['task_id', 'version', 'operation_id'] },
  { name: 'task_release', description: 'Release ownership of a task you own.',
    properties: { task_id: taskId, version: ver, operation_id: operationId }, required: ['task_id', 'version', 'operation_id'] },
  { name: 'decision_record', description: 'Record a decision with rationale and evidence.',
    properties: { project_id: projectId, task_id: taskId, summary: str(undefined, 4096), rationale: str(), evidence: strings(), supersedes: str('Decision ID this replaces.', 256), operation_id: operationId },
    required: ['summary', 'operation_id'] },
  { name: 'team_ask', description: 'Send an addressed question to one or more actors.',
    properties: { project_id: projectId, to: strings('Actor IDs.'), body: str(), task_id: taskId, evidence: strings(),
      wake: { type: 'string', enum: ['none', 'auto', 'force'], description: 'auto: a recipient app offline for 2 minutes is answered by one read-only job on its own adapter (subscription only); force: even when online. The reply arrives marked via jN.' }, operation_id: operationId },
    required: ['to', 'body', 'operation_id'] },
  { name: 'team_reply', description: 'Reply to a question addressed to you.',
    properties: { message_id: str(undefined, 256), body: str(), evidence: strings(), operation_id: operationId }, required: ['message_id', 'body', 'operation_id'] },
  { name: 'team_inbox', description: 'Read questions and replies addressed to you that you have not acknowledged or answered.', properties: { project_id: projectId } },
  { name: 'team_ack', description: 'Acknowledge an addressed message.',
    properties: { message_id: str(undefined, 256), operation_id: operationId }, required: ['message_id', 'operation_id'] },
  { name: 'discussion_open', description: 'Open a focused discussion with one owner who closes it with an outcome.',
    properties: { project_id: projectId, task_id: taskId, subject: str(undefined, 512), question: str(), operation_id: operationId },
    required: ['subject', 'question', 'operation_id'] },
  { name: 'discussion_post', description: 'Post evidence or a reply in an open discussion.',
    properties: { discussion_id: str(undefined, 256), body: str(), reply_to: str(undefined, 256), evidence: strings(), operation_id: operationId },
    required: ['discussion_id', 'body', 'operation_id'] },
  { name: 'discussion_close', description: 'Close a discussion you own with its outcome (answer, decision, experiment or blocker).',
    properties: { discussion_id: str(undefined, 256), outcome: str(undefined, 4096), operation_id: operationId }, required: ['discussion_id', 'outcome', 'operation_id'] },
  { name: 'discussion_read', description: 'Read a discussion and its messages.', properties: { discussion_id: str(undefined, 256) }, required: ['discussion_id'] },
  { name: 'artifact_submit', description: 'Store a text artifact (evidence, logs, patches) up to 4 MB.',
    properties: { project_id: projectId, name: str(undefined, 256), kind: str(undefined, 64), content: { type: 'string', maxLength: 4194304 }, operation_id: operationId },
    required: ['name', 'content', 'operation_id'] },
  { name: 'artifact_read', description: 'Read an artifact.', properties: { artifact_id: str(undefined, 256) }, required: ['artifact_id'] },
  { name: 'job_submit', description: 'Delegate bounded work to a service-run worker that keeps going after this app closes. Omitting route defaults to "auto" (local, then subscription, then paid if cost=paid; workspace-read preference when ctx is empty; another model family for reviews). Route "claude" uses the Claude Code CLI on the subscription, never API billing: mode "advice" (default) is read-only in the project root; mode "edit" works in a new git worktree on branch ac/job-<id> with file-edit tools only (no shell) and leaves changes uncommitted for review. Route "codex" runs the Codex CLI on the ChatGPT subscription inside its own sandbox: read-only for advice; for edit, workspace-write in the job worktree, where it can also run sandboxed commands. Route "openai-api" sends one text request through the original central OpenAI helper, which alone admits and accounts for spending: advice only, no file access (put the needed excerpts in the prompt; never secrets), and it needs purpose, deliverable and max_cost_usd (failing fast with BUDGET_TOO_LOW when the estimated turn-1 reservation exceeds max_cost_usd). Do not manufacture or pad API work. Route "antigravity" sends one reasoning-only prompt through the guarded antigravity-helper on the included Google AI quota (no tools, no file access; put the needed excerpts in the prompt, never secrets): advice only, with task (explain, coding, complex or review) and optional effort and effort_reason; an ambiguous submission is left for review, never replayed.',
    properties: { project_id: projectId, task_id: taskId, route: { type: 'string', enum: [...adapterIds(), 'auto'], description: 'Default "auto": the service picks (local, then subscription, then paid; workspace-read preference when ctx is empty; another model family for reviews; never paid without cost=paid and the spend fields).' }, mode: { type: 'string', enum: ['advice', 'edit'] },
      cost: { type: 'string', enum: ['local', 'sub', 'paid'], description: 'route=auto only: the billing classes allowed (default sub).' },
      shell: { type: 'boolean', description: 'route=auto, edit jobs: the worker needs to run commands.' },
      check: str('Operator-approved check name. With mode=edit, selects AC-managed patch editing and container verification on any route.', 64),
      max_turns: { type: 'integer', minimum: 1, maximum: 20, description: 'Patch edit jobs accept 1-4 turns (default 2). For API tool loops the upper limit is 20.' },
      tools: str('An operator-approved tool set from the shared manifest (air_get tools), e.g. blender. The worker gets only that MCP server; advice jobs get only its read tools. route=auto picks a route that can provide it.', 64),
      intent: { type: 'string', enum: [...INTENTS], description: 'Platform-neutral purpose; with eff, the route profile picks model and effort (explicit model/effort win). edit implies mode edit.' },
      eff: { type: 'string', enum: [...EFFORTS], description: 'Platform-neutral effort (default med when intent is set).' },
      task: { type: 'string', enum: ['explain', 'coding', 'complex', 'review'], description: 'antigravity only: the helper task category (default explain).' },
      effort_reason: str('antigravity only: one line (up to 240 characters) on why this effort fits.', 240),
      prompt: str('Complete, self-contained instructions. claude workers also see the files; openai-api workers see only this prompt.', 200000),
      model: str('Optional model override (defaults to the route profile).', 128), effort: str(undefined, 32),
      timeout_minutes: { type: 'integer', minimum: 1, maximum: 240, description: 'Default 30 (claude), 10 (openai-api, max 15) or 15 (antigravity, max 60).' },
      max_cost_usd: str('openai-api only: explicit ceiling in USD, e.g. "0.25" (a limit, not an amount to spend).', 16),
      max_output_tokens: { type: 'integer', minimum: 256, maximum: 65536, description: 'openai-api only; default 8192, include room for reasoning.' },
      tier: { type: 'string', enum: ['flex', 'default'], description: 'openai-api only; default (Standard) unless set. flex is cheaper but can return 429 when capacity is short, which leaves an uncertain hold in the helper.' },
      purpose: str('openai-api only: the concrete benefit of this request.', 1000), deliverable: str('openai-api only: what the answer is for.', 500),
      protocol: { type: 'string', enum: ['text', 'air', 'patch'], description: 'air: the worker gets the AIR-T worker primer and ends with an @air1 block (checked, never applied; verdict ok|chg|blk).' },
      cwd: str('Working directory in the project root or a registered linked git worktree.', 4096),
      edit_paths: strings('Repository-relative file and directory scopes for advisory overlap warnings on edit jobs.'),
      context_refs: { ...strings('Up to 20 refs resolved now: file:<path>[:a-b+c-d], grep:<path>:<terms>[:context_lines], job:<jN>[:a-b], art:<aN>[:a-b], task:<tN>, diff:<git range> (not on paid routes). File paths are relative to cwd or the project root; secret-like and binary files are refused.'), maxItems: 20 },
      operation_id: operationId },
    required: ['prompt', 'operation_id'] },
  { name: 'job_status', description: 'Read a job: status (queued, running, completed, failed, cancelled, needs_review), result text, changed files, branch and error. The prompt is shortened to a preview unless include_prompt is true.',
    properties: { job_id: str(undefined, 256), include_prompt: { type: 'boolean', description: 'Return the full prompt (default false).' } }, required: ['job_id'] },
  { name: 'job_list', description: "List the project's 50 most recent jobs, optionally by status.", properties: { project_id: projectId, status: str(undefined, 32) } },
  { name: 'job_cancel', description: 'Cancel a queued job, or stop a running one.', properties: { job_id: str(undefined, 256), operation_id: operationId }, required: ['job_id', 'operation_id'] },
];

// AIR-T tools. Their readers are AIs only, so descriptions are terse; the full grammar comes from
// air_sync include_spec=true. The same definitions appear in both profiles.
const pid = str('Project handle (p1) or ID.', 256);
const opid = str('Idempotency key; reuse it to retry.', 256);
const AIR: Record<string, Tool> = {
  air_sync: { name: 'air_sync', description: 'AIR-T read: changes since your last air_sync (snapshot on the first), one line per item: P T D C G M A J, plus R route status. Give root (workspace path) or project_id. task_id: one task only (keeps your read position). include_spec: grammar.',
    properties: { project_id: pid, root: str('Workspace path.', 4096), task_id: str('Task handle or ID.', 256),
      since_seq: { type: 'integer', minimum: 0, description: 'Read from here (0 = snapshot).' },
      include_spec: { type: 'boolean' }, advance_cursor: { type: 'boolean', description: 'false = peek.' } } },
  air_tx: { name: 'air_tx', description: 'AIR-T write: atomic, idempotent packet. "@air1 [p=] [op=]", then "#k opcode key=value \\"text\\""; #j refers to an earlier node. Includes out for job feedback. See air_sync include_spec=true for opcodes. Reply "@air1 ok ..." with handles, or "@air1 err ...".',
    properties: { project_id: pid, packet: str(undefined, 65536), operation_id: opid }, required: ['packet', 'operation_id'] },
  air_get: { name: 'air_get', description: 'AIR-T detail: all fields for up to 25 handles or IDs, e.g. "t4,d19,c42,g3,j5,a8:1-120" (artifact lines); "tools" lists shared skills, MCP servers and CLIs. grep filters artifact lines. raw: exact full text (10 max).',
    properties: { handles: str(undefined, 4096), grep: str(undefined, 256), max_chars: { type: 'integer', minimum: 20, maximum: 200000, description: 'Per-field cap (16000).' },
      raw: { type: 'boolean' } },
    required: ['handles'] },
  air_wait: { name: 'air_wait', description: 'AIR-T: wait for all listed jobs (or the first with any), then show their J lines. Reply "@air1 wait n= done= [timeout=1]".',
    properties: { handles: str('Job handles or IDs, up to 10.', 4096), wait_seconds: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 30.' },
      any: { type: 'boolean' }, max_chars: { type: 'integer', minimum: 20, maximum: 200000 }, brief: { type: 'boolean' } },
    required: ['handles'] },
  art_put: { name: 'art_put', description: 'Store a text artifact (up to 4 MB). The same name and bytes return the existing handle. Reply "A a<N> ... [dedup=1]".',
    properties: { project_id: pid, name: str(undefined, 256), kind: str(undefined, 64), content: { type: 'string', maxLength: 4194304 }, operation_id: opid },
    required: ['name', 'content', 'operation_id'] },
};
tools.push(AIR.air_tx, AIR.air_sync, AIR.air_get, AIR.air_wait);

/** "full": every JSON tool plus the AIR tools (the default). "air": only the AIR tools, set by toolProfile in a connection file. */
export type ToolProfile = 'full' | 'air';
const PROFILES: Record<ToolProfile, Tool[]> = { full: tools, air: [AIR.air_sync, AIR.air_tx, AIR.air_get, AIR.air_wait, AIR.art_put] };
export function profileOf(value: unknown): ToolProfile {
  if (value === undefined || value === null || value === 'full') return 'full';
  if (value === 'air') return 'air';
  throw new Error(`INVALID_TOOL_PROFILE: toolProfile must be "full" or "air", not ${JSON.stringify(value)}`);
}
export const PROJECT_SCOPED = new Set([...tools, AIR.art_put].filter(tool => 'project_id' in tool.properties).map(tool => tool.name));
export const toolsFor = (profile: ToolProfile = 'full') => new Set(PROFILES[profile].map(tool => tool.name));
export const toolNames = toolsFor('full');
export function listedTools(profile: ToolProfile = 'full') {
  return PROFILES[profile].map(tool => ({ name: tool.name, description: tool.description,
    inputSchema: { type: 'object', additionalProperties: false, properties: tool.properties, required: tool.required ?? [] } }));
}

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { call, readConnection, type Connection } from '../src/client.ts';
import { applyPatchBlocks, parsePatchBlocks } from '../src/patch.ts';
import { jobGitEnvironment } from '../src/git-environment.ts';
import { preflightPatchCheck, runPatchCheck, type PatchCheck } from '../src/patch-check.ts';
import { fenceUntrustedData } from '../src/runner.ts';
import { editScopes } from '../src/task-prerequisites.ts';

const fixtures: Fixture[] = [
  {
    id: 'small-change',
    starter: { 'label.mjs': 'export const label = value => String(value);\n' },
    solution: { 'label.mjs': "export const label = value => String(value).trim() || '(empty)';\n" },
    assignments: [{ files: ['label.mjs'], instruction: 'Trim labels and use (empty) for blank labels. Preserve numeric zero.' }],
    checks: "const { label } = await load('label.mjs'); assert.equal(label('  a '), 'a'); assert.equal(label(' '), '(empty)'); assert.equal(label(0), '0');",
  },
  {
    id: 'bug-fix',
    starter: { 'page.mjs': 'export const page = (items, number, size) => items.slice(number * size, (number + 1) * size);\n' },
    solution: { 'page.mjs': 'export const page = (items, number, size) => number < 1 || size < 1 ? [] : items.slice((number - 1) * size, number * size);\n' },
    assignments: [{ files: ['page.mjs'], instruction: 'Fix one-based pagination. Return an empty array for nonpositive page numbers or sizes and for pages beyond the end.' }],
    checks: "const { page } = await load('page.mjs'); assert.deepEqual(page([1,2,3], 1, 2), [1,2]); assert.deepEqual(page([1,2,3], 2, 2), [3]); assert.deepEqual(page([1], 0, 2), []); assert.deepEqual(page([1], 1, 0), []); assert.deepEqual(page([1], 3, 1), []);",
  },
  {
    id: 'split-change',
    starter: { 'subtotal.mjs': 'export const subtotal = lines => 0;\n', 'shipping.mjs': 'export const shipping = cents => 0;\n',
      'order.mjs': "import { subtotal } from './subtotal.mjs';\nimport { shipping } from './shipping.mjs';\nexport const order = lines => subtotal(lines) + shipping(subtotal(lines));\n" },
    solution: { 'subtotal.mjs': 'export const subtotal = lines => lines.reduce((sum, line) => sum + line.cents * line.quantity, 0);\n',
      'shipping.mjs': 'export const shipping = cents => cents === 0 || cents >= 5000 ? 0 : 500;\n' },
    assignments: [
      { files: ['subtotal.mjs'], instruction: 'Compute subtotal in cents from items with cents and quantity properties. Empty orders have subtotal zero.' },
      { files: ['shipping.mjs'], instruction: 'Shipping costs 500 cents for a positive subtotal below 5000 cents. Otherwise shipping is free.' },
    ],
    checks: "const { order } = await load('order.mjs'); assert.equal(order([]), 0); assert.equal(order([{cents: 2000, quantity: 2}, {cents: 50, quantity: 2}]), 4600); assert.equal(order([{cents: 2500, quantity: 2}]), 5000);",
  },
];

interface Fixture {
  id: string;
  starter: Record<string, string>;
  solution: Record<string, string>;
  assignments: Assignment[];
  checks: string;
}
interface Assignment { files: string[]; instruction: string }
interface Usage { tokens: number | null; costUsd: number | null }
interface Response extends Usage { result: string }
interface Live { connection: Connection; worker: string; reviewer: string; image: string }
const modes = ['solo', 'review', 'split'] as const;
const unreported = { tokens: null, costUsd: null };

function benchmarkCheck(image: string): PatchCheck {
  return { name: 'benchmark-acceptance', docker: 'docker', image, argv: ['node', '/input/acceptance.mjs', '/input/candidate'],
    timeout_seconds: 30, protected_paths: [], share_failure_output: false };
}

async function acceptCandidate(checks: string, cwd: string, files: string[], marker: string, live?: Live): Promise<boolean> {
  if (!live) {
    const checked = spawnSync(process.execPath, [checks, cwd], { cwd: path.dirname(checks), encoding: 'utf8', timeout: 30000,
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
    return checked.status === 0 && checked.stdout.trimEnd().split(/\r?\n/).at(-1) === marker;
  }
  const input = `${cwd}-acceptance-input`, candidate = path.join(input, 'candidate');
  fs.mkdirSync(candidate, { recursive: true });
  fs.copyFileSync(checks, path.join(input, 'acceptance.mjs'));
  for (const file of files) fs.copyFileSync(path.join(cwd, file), path.join(candidate, file));
  const result = await runPatchCheck(benchmarkCheck(live.image), input, `${cwd}-acceptance-run`,
    `ac-bench-${randomUUID()}`, 30000, () => {});
  return result.exitCode === 0 && result.output.trimEnd().split(/\r?\n/).at(-1) === marker;
}

function git(cwd: string, args: string[], date?: string): string {
  const env = jobGitEnvironment();
  const configured = date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env;
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=AC Benchmark', '-c', 'user.email=benchmark@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: configured, windowsHide: true, timeout: 30000 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
}

async function liveJob(live: Live, project: string, route: string, intent: 'code' | 'review', files: string[], prompt: string): Promise<Response> {
  const submitted = await call(live.connection, 'job_submit', { project_id: project, operation_id: randomUUID(), route,
    cost: 'sub', intent, mode: 'advice', protocol: intent === 'code' ? 'patch' : 'text', repair: 'off', timeout_minutes: 10,
    context_refs: files.map(file => `file:${file}`), prompt });
  const id = submitted.job.id;
  const deadline = Date.now() + 12 * 60_000;
  await call(live.connection, 'air_wait', { handles: id, wait_seconds: 45, brief: true });
  for (;;) {
    const { job } = await call(live.connection, 'job_status', { job_id: id });
    if (job.status === 'completed') {
      const detail = await call(live.connection, 'air_get', { handles: id, raw: true });
      const raw = detail.raw?.[0];
      if (raw?.complete !== true || typeof raw.content !== 'string') throw new Error('Complete benchmark job output unavailable');
      const cost = typeof job.cost_usd === 'string' && job.cost_usd.trim() ? Number(job.cost_usd) : job.cost_usd;
      return { result: raw.content, tokens: Number.isFinite(job.tokens_in) && Number.isFinite(job.tokens_out) ? job.tokens_in + job.tokens_out : null,
        costUsd: Number.isFinite(cost) ? cost : null };
    }
    if (!['queued', 'running'].includes(job.status)) throw new Error(`Benchmark job ${id}: ${job.status}`);
    if (Date.now() >= deadline) throw new Error(`Benchmark job ${id} is still pending. Its checkout was retained.`);
    await call(live.connection, 'air_wait', { handles: id, wait_seconds: 45, brief: true });
  }
}

export async function runDelegationBenchmark(scratch: string, options: { live?: Live; omitStubEditFor?: string; stubConflictFor?: string } = {}) {
  const root = fs.realpathSync(scratch);
  const run = fs.mkdtempSync(path.join(root, 'ac-delegation-'));
  const report = [];
  try {
    if (options.live) preflightPatchCheck(benchmarkCheck(options.live.image), run);
    for (const fixture of fixtures) {
      const checks = path.join(run, `${fixture.id}.mjs`);
      const accepted = `ACCEPTED-${randomUUID()}`;
      fs.writeFileSync(checks, "import assert from 'node:assert/strict';\nimport { pathToFileURL } from 'node:url';\nimport path from 'node:path';\n"
        + "const load = file => import(pathToFileURL(path.join(process.argv[2], file)).href);\n" + fixture.checks
        + `\nconsole.log(${JSON.stringify(accepted)});\n`);
      const starter = path.join(run, `${fixture.id}-starter`);
      fs.mkdirSync(starter);
      for (const [file, content] of Object.entries(fixture.starter)) fs.writeFileSync(path.join(starter, file), content);
      git(starter, ['init', '-q', '-b', 'main']);
      git(starter, ['add', '--all']);
      git(starter, ['commit', '-qm', 'Benchmark input'], '2020-01-01T00:00:00Z');
      const revision = git(starter, ['rev-parse', 'HEAD']);
      for (const mode of modes) {
        const started = performance.now();
        const cwd = path.join(run, `${fixture.id}-${mode}`);
        fs.cpSync(starter, cwd, { recursive: true });
        const all = Object.keys(fixture.starter);
        const writes = [...new Set(fixture.assignments.flatMap(item => item.files))];
        const requirements = fixture.assignments.map(item => item.instruction).join('\n');
        const work = mode === 'split' ? fixture.assignments : [{ files: writes, instruction: requirements }];
        const live = options.live;
        const project = live ? (await call(live.connection, 'project_create', { operation_id: randomUUID(),
          name: `Delegation benchmark: ${fixture.id} ${mode}`, root: cwd })).project.id : '';
        const observations: Usage[] = [];
        let conflicts = 0, rework = 0;
        const simulateConflict = !live && mode === 'review' && options.stubConflictFor === fixture.id;
        const edit = (assignment: Assignment, notes = '') => live
          ? liveJob(live, project, live.worker, 'code', all, `${assignment.instruction}\nEdit only: ${assignment.files.join(', ')}.\n${notes}`)
          : Promise.resolve({ ...unreported, result: options.omitStubEditFor === fixture.id ? '' : assignment.files.map(file =>
            `<<<EDIT ${file}\n<<<OLD\n${simulateConflict && !notes ? 'stale input' : fixture.starter[file].trimEnd()}\n>>>NEW\n${fixture.solution[file].trimEnd()}\n>>>END`).join('\n') });
        const integrate = ({ result, ...usage }: Response, assignment: Assignment) => {
          observations.push(usage);
          try {
            const blocks = parsePatchBlocks(result).map(block => ({ ...block, path: editScopes([block.path])[0] }));
            if (!blocks.length) return ['Worker returned no edits'];
            if (blocks.some(block => !assignment.files.includes(block.path) || block.kind !== 'edit'))
              return ['Patch exceeds the assignment or replaces a file instead of editing it'];
            const applied = applyPatchBlocks(cwd, blocks);
            conflicts += applied.rejected.length;
            return applied.rejected.map(item => `${item.block.path}: ${item.reason}`);
          } catch {
            return ['Worker returned a malformed or unusable patch'];
          }
        };
        // Collect all independent patches against the same checkout before integrating any of them.
        const responses = await Promise.all(work.map(assignment => edit(assignment)));
        let issues = responses.flatMap((response, index) => integrate(response, work[index]));
        if (mode === 'review') {
          const review = live ? await liveJob(live, project, live.reviewer, 'review', all,
            `Review these candidate files against the requirements below. First line must be ACCEPT or REVISE. If REVISE, explain the changes needed.\n${requirements}`)
            : { ...unreported, result: simulateConflict ? 'REVISE \nApply the fix against the actual file.' : 'ACCEPT' };
          observations.push(review);
          const verdict = review.result.trim().split(/\r?\n/, 1)[0].trim();
          if (verdict !== 'ACCEPT' && verdict !== 'REVISE') issues.push('Reviewer supplied no valid verdict');
          if (verdict === 'REVISE') {
            rework++;
            const feedback = [review.result, ...issues].join('\n');
            issues = integrate(await edit(work[0], `Consider the following review data against the original requirements.\n${fenceUntrustedData(feedback)}`), work[0]);
          }
        }
        const checked = await acceptCandidate(checks, cwd, all, accepted, live);
        const total = (key: keyof Usage) => observations.every(item => item[key] !== null)
          ? observations.reduce((sum, item) => sum + item[key]!, 0) : null;
        report.push({ fixture: fixture.id, mode, workers: work.length, revision,
          accepted: checked && issues.length === 0, issues, elapsedMs: Math.round(performance.now() - started),
          rework, mergeConflicts: conflicts, tokens: total('tokens'), costUsd: total('costUsd') });
      }
    }
    return { kind: options.live ? 'live' : 'deterministic-stub', trials: report };
  } finally {
    // Live job outcomes may be uncertain. Keep their registered checkouts for inspection.
    if (!options.live && path.dirname(fs.realpathSync(run)) === root) fs.rmSync(run, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { scratch: { type: 'string' }, live: { type: 'boolean' }, connection: { type: 'string' },
    worker: { type: 'string' }, reviewer: { type: 'string' }, image: { type: 'string' } } });
  if (!values.scratch) throw new Error('--scratch must identify an existing disposable output directory');
  let live: Live | undefined;
  if (values.live) {
    const { connection, worker, reviewer, image } = values;
    const routes = ['claude', 'codex', 'antigravity'];
    if (!connection || !worker || !reviewer || !routes.includes(worker) || !routes.includes(reviewer) || worker === reviewer
      || !image || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error('--live needs an operator --connection, separate subscription --worker and --reviewer routes, and a digest-pinned local Node Docker --image');
    live = { connection: readConnection(connection), worker, reviewer, image };
  }
  const report = await runDelegationBenchmark(values.scratch, { live });
  console.log(JSON.stringify(report, null, 2));
  if (report.trials.some(trial => !trial.accepted)) process.exitCode = 1;
}

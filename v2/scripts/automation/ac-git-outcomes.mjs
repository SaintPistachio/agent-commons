#!/usr/bin/env node
// Git hook helper: records explicit job feedback (`out`) in Agent Commons when job results are kept or discarded.
//
//   node ac-git-outcomes.mjs post-commit [--dry-run]   reads HEAD's commit message trailers
//   node ac-git-outcomes.mjs post-merge  [--dry-run]   a merge of an edit job's ac/job-<id> branch -> accepted
//
// Trailers (one or more lines anywhere in the message; jobs as jN, a UUID or an 8+ character UUID prefix):
//   AC-Accepted: j88 j91            the job's result was kept (merged, applied and committed)
//   AC-Rejected: j90 wrong file     the result was discarded; words after the job refs are the reason
//   AC-Redone: j92 by j95           the work was redone by another job (optional "by jN" links the replacement)
//
// The feedback is recorded as the app that submitted the job (its connection file in <home>\connections), because
// only the submitter may record accepted/rejected/redone. Each (job, outcome) is recorded once: the operation key is
// git-out:<job>:<outcome>. The hook never blocks git: any problem prints at most one line to stderr and exits 0.
import { execFileSync } from 'node:child_process';
import { acHome, airTx, args, findJob, flag, loadConnection, openDb, option, q } from './ac-client.mjs';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const JOB_REF = /^(j\d+|[0-9a-f]{8}(?:[0-9a-f-]{0,28}))$/i;

/** Pure: [{ job, kind, reason, replacement? }] from a commit message. Exported for tests. */
export function parseTrailers(message) {
  const found = [];
  for (const line of message.split(/\r?\n/)) {
    const m = /^AC-(Accepted|Rejected|Redone):\s*(.+)$/i.exec(line.trim());
    if (!m) continue;
    const kind = m[1].toLowerCase();
    const words = m[2].trim().split(/[\s,]+/);
    const jobs = [];
    let i = 0;
    for (; i < words.length && JOB_REF.test(words[i]); i++) jobs.push(words[i]);
    let rest = words.slice(i);
    let replacement;
    if (kind === 'redone' && rest[0]?.toLowerCase() === 'by' && JOB_REF.test(rest[1] ?? '')) { replacement = rest[1]; rest = rest.slice(2); }
    for (const job of jobs) found.push({ job, kind, reason: rest.join(' '), ...(replacement ? { replacement } : {}) });
  }
  return found;
}

/** Pure: the job ID prefix from a merge reflog subject such as "merge ac/job-1a2b3c4d: Fast-forward". */
export function mergedJobBranch(reflogSubject) {
  const m = /^merge (?:refs\/heads\/)?ac\/job-([0-9a-f]{8}):/i.exec(reflogSubject ?? '');
  return m ? m[1] : null;
}

async function record(items, context) {
  if (!items.length) return;
  const home = acHome();
  const db = await openDb(home);
  try {
    for (const item of items) {
      const job = findJob(db, item.job);
      if (!job) { console.error(`ac-git-outcomes: ${item.job}: no such job`); continue; }
      if (item.kind !== 'redone' && job.status !== 'completed') { console.error(`ac-git-outcomes: ${item.job} is ${job.status}, not completed`); continue; }
      const replacement = item.replacement ? findJob(db, item.replacement) : null;
      const reason = `${context}${item.reason ? ': ' + item.reason : ''}`;
      const packet = `@air1\n#0 out j=${job.id} v=${item.kind}${replacement ? ` replacement=${replacement.id}` : ''} ${q(reason)}`;
      if (flag('dry-run')) { console.log(`[dry run] as ${job.created_by}: ${packet.split('\n')[1]}`); continue; }
      const connection = loadConnection(job.created_by, home);
      if (!connection) { console.error(`ac-git-outcomes: no connection file for ${job.created_by}`); continue; }
      try {
        await airTx(connection, job.project_id, packet, `git-out:${job.id}:${item.kind}`);
      } catch (error) {
        console.error(`ac-git-outcomes: ${item.job}: ${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
  } finally { db.close(); }
}

async function main() {
  const event = args[0];
  // The hook passes the event's commit, reflog subject and squash flag, captured before it went to the background.
  const sha = option('sha') || git('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) return;
  const short = sha.slice(0, 12);
  let branch = '';
  try { branch = git('rev-parse', '--abbrev-ref', 'HEAD'); } catch { /* detached */ }
  // Only the commit's real trailer block (git's own parsing), never trailer-like lines in the body.
  const trailers = () => parseTrailers(git('log', '-1', '--format=%(trailers:only,unfold)', sha));
  if (event === 'post-commit') {
    await record(trailers(), `git commit ${short} on ${branch}`);
  } else if (event === 'post-merge') {
    if (option('squash', '0') === '1') return;  // a squash merge is not committed yet; its commit's trailers count
    const subject = option('subject') ?? git('reflog', '-1', '--format=%gs', 'HEAD');
    const prefix = mergedJobBranch(subject);
    const items = prefix ? [{ job: prefix, kind: 'accepted', reason: '' }] : [];
    // A true merge commit's own message may carry trailers; a fast-forward's HEAD is someone else's commit.
    const parents = git('rev-list', '--parents', '-n', '1', sha).split(' ').length - 1;
    if (parents >= 2) items.push(...trailers());
    await record(items, `git merge into ${branch} at ${short}`);
  }
}

if (/ac-git-outcomes\.mjs$/i.test(process.argv[1] ?? '')) {
  main().catch(error => console.error(`ac-git-outcomes: ${String(error?.message ?? error).slice(0, 200)}`)).finally(() => process.exit(0));
}

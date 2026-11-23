// AIR-T token benchmark. Use a synthetic fixture database. It copies the fixture twice with the SQLite backup API
// into a scratch folder, replays the same 20 recent work sessions through the JSON tools on one copy and through
// air_sync + air_tx on the other, and compares what crosses the MCP boundary.
//
//   node --disable-warning=ExperimentalWarning v2/scripts/air-benchmark.ts --db <commons.sqlite> --scratch <dir> [--project <id>] [--sessions 20]
//
// Tokens are estimated as characters / 4 (no tokenizer dependency is allowed); the ratio between the two paths is
// what matters. A JSON tool reply is counted as MCP sends it (structuredContent plus the same JSON as text) and as
// text only, because clients differ in what they pass to the model.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { Store, type Actor } from '../src/store.ts';
import { listedTools } from '../src/tools.ts';
import { AIR_PRIMER } from '../src/air/primer.ts';
import { assertNotSyncedPath } from '../src/backup-bundle.ts';

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : fallback; };
const source = arg('db'), scratch = arg('scratch');
if (!source || !scratch) { console.error('usage: air-benchmark.ts --db <commons.sqlite> --scratch <dir> [--project <id>] [--sessions 20]'); process.exit(2); }
const sessions = Number(arg('sessions', '20'));
const tokens = (chars: number) => Math.round(chars / 4);

assertNotSyncedPath(scratch, 'benchmark scratch directory');
if (!fs.lstatSync(scratch, { throwIfNoEntry: false })?.isDirectory() || fs.readdirSync(scratch).length) {
  throw new Error('Use an existing, empty, private benchmark scratch directory');
}
const copies = ['json', 'air'].map(name => path.join(scratch, name));
const live = new DatabaseSync(source, { readOnly: true });
try {
  for (const dir of copies) { fs.mkdirSync(dir, { mode: 0o700 }); await backup(live, path.join(dir, 'commons.sqlite')); }
} finally { live.close(); }

const jsonStore = new Store(copies[0]), airStore = new Store(copies[1]);
const actor: Actor = { id: 'claude-desktop', name: 'claude-desktop', role: 'participant' };
try {
  // The busiest project unless one is named; the 20 most recent project-level checkpoints, each paired with the
  // decision recorded just before it (when there is one), replayed oldest first.
  const projectId = arg('project') ?? jsonStore.db.prepare('SELECT project_id FROM checkpoints GROUP BY project_id ORDER BY count(*) DESC LIMIT 1').get()?.project_id as string | undefined;
  if (!projectId) throw new Error('The fixture must contain a project with checkpoints');
  const checkpoints = (jsonStore.db.prepare('SELECT * FROM checkpoints WHERE project_id=? AND task_id IS NULL ORDER BY seq DESC LIMIT ?').all(projectId, sessions) as any[]).reverse();
  if (!checkpoints.length) throw new Error('The fixture project must contain project-level checkpoints');
  const decisionBefore = (at: string) => jsonStore.db.prepare('SELECT * FROM decisions WHERE project_id=? AND created_at<=? ORDER BY created_at DESC LIMIT 1').get(projectId, at) as any;

  const totals = { json: { calls: 0, args: 0, sent: 0, text: 0 }, air: { calls: 0, args: 0, sent: 0, text: 0 } };
  const jsonCall = (method: string, input: any) => {
    const result = jsonStore.call(actor, method, input), text = JSON.stringify(result);
    totals.json.calls++; totals.json.args += JSON.stringify(input).length; totals.json.text += text.length; totals.json.sent += text.length * 2;
    return result;
  };
  const airCall = (method: string, input: any) => {
    const result = airStore.call(actor, method, input);
    totals.air.calls++; totals.air.args += JSON.stringify(input).length; totals.air.text += result.air.length; totals.air.sent += result.air.length;
    return result;
  };
  const quote = (s: string) => JSON.stringify(s);
  const list = (items: string[]) => items.map(quote).join(',');
  let firstSnapshot = 0, firstResume = 0;
  for (const [n, c] of checkpoints.entries()) {
    const d = decisionBefore(c.created_at), checks: string[] = JSON.parse(c.checks), questions: string[] = JSON.parse(c.open_questions);
    // JSON path: resume, record the decision, publish the checkpoint (three round trips).
    const resume = jsonCall('project_resume', { project_id: projectId });
    if (n === 0) firstResume = JSON.stringify(resume).length;
    if (d) jsonCall('decision_record', { project_id: projectId, summary: d.summary, rationale: d.rationale || undefined,
      evidence: JSON.parse(d.evidence), operation_id: randomUUID() });
    jsonCall('project_checkpoint', { project_id: projectId, summary: c.summary, revision: c.revision ?? undefined, branch: c.branch ?? undefined,
      next_action: c.next_action ?? undefined, checks, open_questions: questions, operation_id: randomUUID() });
    // AIR-T path: sync (snapshot first, then changes), then one air_tx with the same content (two round trips).
    const sync = airCall('air_sync', { project_id: projectId });
    if (n === 0) firstSnapshot = sync.air.length;
    const lines = ['@air1'];
    if (d) lines.push(`#${lines.length - 1} dec ${quote(d.summary)}` + (d.rationale ? ` why=${quote(d.rationale)}` : '') + (JSON.parse(d.evidence).length ? ` ev=${list(JSON.parse(d.evidence))}` : ''));
    lines.push(`#${lines.length - 1} chk ${quote(c.summary)}` + (c.revision ? ` rev=${quote(c.revision)}` : '') + (c.branch ? ` br=${quote(c.branch)}` : '')
      + (checks.length ? ` ok=${list(checks)}` : '') + (questions.length ? ` q=${list(questions)}` : '') + (c.next_action ? ` next=${quote(c.next_action)}` : ''));
    airCall('air_tx', { project_id: projectId, packet: lines.join('\n'), operation_id: randomUUID() });
  }
  // Fixed per-session costs. Every session loads the whole tools/list payload once. Three catalogs: the JSON tools
  // alone (the pre-AIR baseline), today's full catalog (JSON + AIR tools, what apps load now), and the AIR tools
  // alone (toolProfile "air"). AIR-T also needs the ~20-line shared rule from Phase C (estimated at 200 tokens).
  const jsonOnly = listedTools('full').filter(t => !t.name.startsWith('air_'));
  const lists = { json: jsonOnly, full: listedTools('full'), air: listedTools('air') };
  const catalog = { json: tokens(JSON.stringify({ tools: lists.json }).length), full: tokens(JSON.stringify({ tools: lists.full }).length), air: tokens(JSON.stringify({ tools: lists.air }).length) };
  const toolCount = { json: lists.json.length, full: lists.full.length, air: lists.air.length };
  const rule = 200, sessionsN = checkpoints.length;
  const traffic = { json: tokens(totals.json.args + totals.json.text) / sessionsN, air: tokens(totals.air.args + totals.air.text) / sessionsN };
  const session = { json: Math.round(catalog.json + traffic.json), full: Math.round(catalog.full + rule + traffic.air), air: Math.round(catalog.air + rule + traffic.air) };
  const row = (label: string, json: number, air: number) => `| ${label} | ${json.toLocaleString('en-US')} | ${air.toLocaleString('en-US')} | ${json ? Math.round((1 - air / json) * 100) : 0}% |`;
  const perSessionOverhead = catalog.air + rule;
  const report = [
    `# AIR-T v0.1 token benchmark`, '',
    `Run ${new Date().toISOString().slice(0, 16)}Z on local copies of the fixture database. Project ${projectId}, ${checkpoints.length} sessions`
      + ` replayed from its most recent project-level checkpoints, each with the decision recorded just before it. Tokens = characters / 4 (estimate).`, '',
    '| Measure | JSON tools | AIR-T | Saved |', '| --- | ---: | ---: | ---: |',
    row('Round trips', totals.json.calls, totals.air.calls),
    row('Tool-call arguments (tokens the model writes)', tokens(totals.json.args), tokens(totals.air.args)),
    row('Replies as sent over MCP (structuredContent + text)', tokens(totals.json.sent), tokens(totals.air.sent)),
    row('Replies, text content only', tokens(totals.json.text), tokens(totals.air.text)),
    row('First read only: project_resume vs air_sync snapshot', tokens(firstResume), tokens(firstSnapshot)), '',
    '', '## Full session cost (tools/list + traffic, text-only replies)', '',
    '| Catalog loaded | Tools | tools/list | Shared rule | Traffic per session | Total per session | Saved vs JSON |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| JSON tools only (baseline) | ${toolCount.json} | ${catalog.json.toLocaleString('en-US')} | 0 | ${Math.round(traffic.json).toLocaleString('en-US')} | ${session.json.toLocaleString('en-US')} | 0% |`,
    `| Full catalog, using AIR-T (today) | ${toolCount.full} | ${catalog.full.toLocaleString('en-US')} | ${rule} | ${Math.round(traffic.air).toLocaleString('en-US')} | ${session.full.toLocaleString('en-US')} | ${Math.round((1 - session.full / session.json) * 100)}% |`,
    `| AIR profile (toolProfile: air) | ${toolCount.air} | ${catalog.air.toLocaleString('en-US')} | ${rule} | ${Math.round(traffic.air).toLocaleString('en-US')} | ${session.air.toLocaleString('en-US')} | ${Math.round((1 - session.air / session.json) * 100)}% |`, '',
    `The tools/list payload is counted once per session. The AIR profile lists ${lists.air.map(t => t.name).join(', ')}.`
      + ` The AIR-T quick reference (${tokens(AIR_PRIMER.length)} tokens) is only sent when asked for. Fixed AIR-T cost`
      + ` in the AIR profile: about ${perSessionOverhead} tokens.`,
  ].join('\n');
  console.log(report);
  const out = arg('out'); if (out) fs.writeFileSync(out, report + '\n');
} finally { jsonStore.close(); airStore.close(); }

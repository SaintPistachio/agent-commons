import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { CodexResetSummary, UsageDiagnostic, UsageWindow } from './adapters/types.ts';
import { codexExpiringResets } from './adapters/codex-limits.ts';
import { downsamplePoints, formatCompactDuration, formatPaceSummary, windowLengthMs, windowPace, type UsageHistoryCycle } from './allowance.ts';

/**
 * Read-only room viewer. It opens the service database read-only (SQLite WAL lets it read while the service writes),
 * never calls the service and never writes, so it cannot change jobs, rooms or spending. Two front ends share one
 * renderer: `room-report` writes a self-contained HTML snapshot, and `view` serves the same pages on a loopback port.
 */

type Row = Record<string, any>;
const MAX_EMBED = 300 * 1024;
const VIEWER_PORT = 4728;
export { VIEWER_PORT };

export function openViewerDb(home: string): DatabaseSync {
  const file = path.join(home, 'commons.sqlite');
  if (!fs.existsSync(file)) throw new Error(`no Agent Commons database at ${file}`);
  return new DatabaseSync(file, { readOnly: true });
}

const parse = (text: unknown, fallback: any) => { try { return text ? JSON.parse(String(text)) : fallback; } catch { return fallback; } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** g7 -> the discussion row; also accepts a full ID. */
function byHandle(db: DatabaseSync, table: string, letter: string, ref: string): Row | undefined {
  const m = new RegExp(`^${letter}(\\d+)$`).exec(ref.trim());
  if (m) return db.prepare(`SELECT * FROM ${table} WHERE seq=?`).get(Number(m[1])) as Row | undefined;
  return UUID.test(ref) ? db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(ref) as Row | undefined : undefined;
}
function shortId(db: DatabaseSync, letter: 'p' | 'a', id: string | null | undefined): string | null {
  if (!id) return null;
  const row = db.prepare('SELECT num FROM short_ids WHERE kind=? AND id=?').get(letter, id) as Row | undefined;
  return row ? letter + row.num : null;
}
function seqHandle(db: DatabaseSync, table: string, letter: string, id: string | null | undefined): string | null {
  if (!id) return null;
  const row = db.prepare(`SELECT seq FROM ${table} WHERE id=?`).get(id) as Row | undefined;
  return row ? letter + row.seq : null;
}

export interface RoomSummary {
  handle: string; subject: string; project: string; owner: string; status: string; room_status: string | null; mode: string | null;
  round: number; max_rounds: number | null; seats: Row[]; jobs: number; messages: number; created_at: string;
}

export function listRooms(db: DatabaseSync): RoomSummary[] {
  return (db.prepare(`SELECT d.*, p.name project_name,
      (SELECT count(*) FROM jobs j WHERE j.room_id=d.id) job_count,
      (SELECT count(*) FROM messages m WHERE m.discussion_id=d.id) message_count
    FROM discussions d LEFT JOIN projects p ON p.id=d.project_id ORDER BY d.seq DESC`).all() as Row[]).map(d => ({
    handle: 'g' + d.seq, subject: d.subject, project: d.project_name ?? d.project_id, owner: d.owner, status: d.status,
    room_status: d.room_status ?? null, mode: d.room_mode ?? null, round: Number(d.round ?? 0), max_rounds: d.max_rounds ?? null,
    seats: parse(d.seats, []), jobs: Number(d.job_count), messages: Number(d.message_count), created_at: d.created_at,
  }));
}

export interface ArtifactRef { handle: string; id: string; name: string; kind: string; bytes: number; created_at: string; actor: string; used_by: string[] }
export interface JobView {
  handle: string; id: string; round: number | null; seat: string | null; route: string; mode: string; model: string | null; effort: string | null;
  status: string; verdict: string | null; confidence: number | null; summary: string | null; turns: number | null;
  created_at: string; started_at: string | null; finished_at: string | null; cost_usd: number | null; tokens_in: number | null; tokens_out: number | null;
  error: string | null; prompt: string; result: string | null; created_by: string; ctx: string[]; ctx_artifact: string | null; ctx_chars: number | null;
  outcomes: Array<{ kind: string; detail: string | null; actor: string; at: string }>; message: string | null;
}
export interface MessageView { handle: string; sender: string; type: string; body: string; confidence: number | null; evidence: string[]; reply_to: string | null; created_at: string }
export interface RoomView {
  handle: string; id: string; subject: string; question: string; owner: string; status: string; outcome: string | null;
  mode: string | null; round: number; max_rounds: number | null; room_status: string | null; seats: Row[];
  project: { handle: string | null; name: string }; task: string | null; created_at: string; closed_at: string | null;
  messages: MessageView[]; jobs: JobView[]; artifacts: ArtifactRef[]; events: Array<{ action: string; actor: string; at: string }>;
}

export function loadRoom(db: DatabaseSync, ref: string): RoomView | null {
  const d = byHandle(db, 'discussions', 'g', ref);
  if (!d) return null;
  const project = db.prepare('SELECT id,name FROM projects WHERE id=?').get(d.project_id) as Row | undefined;
  const jobRows = db.prepare('SELECT * FROM jobs WHERE room_id=? ORDER BY room_round, seq').all(d.id) as Row[];
  const jobHandle = new Map(jobRows.map(j => [j.id, 'j' + j.seq]));
  const toJob = (e: string) => jobHandle.get(e) ?? (UUID.test(e) ? seqHandle(db, 'jobs', 'j', e) ?? e : e);
  const messages: MessageView[] = (db.prepare('SELECT * FROM messages WHERE discussion_id=? ORDER BY seq').all(d.id) as Row[]).map(m => ({
    handle: 'm' + m.seq, sender: m.sender_id, type: m.type, body: m.body, confidence: m.confidence ?? null,
    evidence: (parse(m.evidence, []) as string[]).map(toJob), reply_to: seqHandle(db, 'messages', 'm', m.reply_to), created_at: m.created_at,
  }));
  const postOf = new Map<string, string>();
  for (const m of messages) for (const e of m.evidence) if (!postOf.has(e)) postOf.set(e, m.handle);

  const artifacts = new Map<string, ArtifactRef>();
  const addArtifact = (id: string, user: string) => {
    const a = db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Row | undefined;
    if (!a) return null;
    const handle = shortId(db, 'a', a.id) ?? a.id;
    const known: ArtifactRef = artifacts.get(handle) ?? { handle, id: a.id, name: a.name, kind: a.kind, bytes: a.bytes, created_at: a.created_at, actor: a.actor_id, used_by: [] as string[] };
    if (!known.used_by.includes(user)) known.used_by.push(user);
    artifacts.set(handle, known);
    return handle;
  };
  const artifactIdOf = (ref: string) => {
    const m = /^a(\d+)$/.exec(ref);
    if (m) return (db.prepare("SELECT id FROM short_ids WHERE kind='a' AND num=?").get(Number(m[1])) as Row | undefined)?.id as string | undefined;
    return UUID.test(ref) ? ref : undefined;
  };

  const jobs: JobView[] = jobRows.map(j => {
    const options = parse(j.options, {});
    const handle = 'j' + j.seq;
    const ctx: string[] = Array.isArray(options.ctx) ? options.ctx.map(String) : [];
    for (const c of ctx) {
      const art = /^art:(.+)$/.exec(c)?.[1];
      const id = art ? artifactIdOf(art) : undefined;
      if (id) addArtifact(id, handle);
    }
    const ctxArtifact = typeof options.ctx_artifact === 'string' ? addArtifact(options.ctx_artifact, handle) : null;
    for (const key of ['output_artifact', 'transcript_artifact']) if (typeof options[key] === 'string') addArtifact(options[key], handle);
    const outcomes = (db.prepare('SELECT kind,detail,actor_id,created_at FROM job_outcomes WHERE job_id=? ORDER BY id').all(j.id) as Row[])
      .map(o => ({ kind: o.kind, detail: o.detail ?? null, actor: o.actor_id, at: o.created_at }));
    return {
      handle, id: j.id, round: j.room_round ?? null, seat: options.seat ?? null, route: j.route, mode: j.mode,
      model: j.reported_model ?? j.resolved_model ?? j.model ?? null, effort: j.resolved_eff ?? j.effort ?? null, status: j.status,
      verdict: j.consult_verdict ?? options.air?.verdict ?? null, confidence: typeof options.air?.p === 'number' ? options.air.p : null,
      summary: options.air?.summary ?? null, turns: j.turns ?? null, created_at: j.created_at, started_at: j.started_at ?? null,
      finished_at: j.finished_at ?? null, cost_usd: j.cost_usd ?? null, tokens_in: j.tokens_in ?? null, tokens_out: j.tokens_out ?? null,
      error: j.error ?? null, prompt: j.prompt, result: j.result ?? null, created_by: j.created_by, ctx, ctx_artifact: ctxArtifact,
      ctx_chars: typeof options.ctx_chars === 'number' ? options.ctx_chars : null, outcomes, message: postOf.get(handle) ?? null,
    };
  });
  const events = (db.prepare('SELECT action,actor_id,created_at FROM events WHERE entity_id=? ORDER BY seq').all(d.id) as Row[])
    .map(e => ({ action: e.action, actor: e.actor_id, at: e.created_at }));
  return {
    handle: 'g' + d.seq, id: d.id, subject: d.subject, question: d.question, owner: d.owner, status: d.status, outcome: d.outcome ?? null,
    mode: d.room_mode ?? null, round: Number(d.round ?? 0), max_rounds: d.max_rounds ?? null, room_status: d.room_status ?? null,
    seats: parse(d.seats, []), project: { handle: shortId(db, 'p', d.project_id), name: project?.name ?? d.project_id },
    task: seqHandle(db, 'tasks', 't', d.task_id), created_at: d.created_at,
    closed_at: [...events].reverse().find(e => e.action === 'discussion_close')?.at ?? null,
    messages, jobs, artifacts: [...artifacts.values()], events,
  };
}

export interface ArtifactView { handle: string; name: string; kind: string; bytes: number; created_at: string; actor: string; content: string | null }
export function loadArtifact(db: DatabaseSync, home: string, ref: string): ArtifactView | null {
  const m = /^a(\d+)$/.exec(ref.trim());
  const id = m ? (db.prepare("SELECT id FROM short_ids WHERE kind='a' AND num=?").get(Number(m[1])) as Row | undefined)?.id : UUID.test(ref) ? ref : undefined;
  if (!id) return null;
  const a = db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Row | undefined;
  if (!a) return null;
  // Artifact files are content-addressed by sha256; the name in the row is never used as a path.
  const file = /^[0-9a-f]{64}$/.test(a.sha256) ? path.join(home, 'artifacts', a.sha256) : null;
  const content = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  return { handle: shortId(db, 'a', a.id) ?? a.id, name: a.name, kind: a.kind, bytes: a.bytes, created_at: a.created_at, actor: a.actor_id, content };
}

// ---- rendering --------------------------------------------------------------------------------------------------

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
export function duration(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  const s = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const kb = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
const ROUTE_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', 'openai-api': 'OpenAI API' };
const routeName = (route: string) => ROUTE_NAME[route] ?? route;
const tone = (value: string | null) => {
  if (!value) return 'muted';
  if (['ok', 'completed', 'converged', 'accepted', 'verify_pass', 'applied', 'verified'].includes(value)) return 'good';
  if (['chg', 'capped', 'needs_review', 'redone', 'running', 'queued', 'open', 'idle', 'stepping', 'drifted'].includes(value)) return 'warn';
  if (['failed', 'rejected', 'verify_fail', 'cancelled', 'blk', 'block', 'blocked', 'unavailable'].includes(value)) return 'bad';
  return 'muted';
};
const badge = (value: string | null | undefined, label?: string) => value ? `<span class="badge ${tone(value)}">${esc(label ?? value)}</span>` : '';
const pre = (text: string | null | undefined) => `<pre>${esc(text ?? '')}</pre>`;
const fold = (summary: string, body: string, open = false) => `<details${open ? ' open' : ''}><summary>${summary}</summary>${body}</details>`;

const STYLE = `
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#65655f;--line:#dddcd6;--accent:#2d5bd7;--good:#1f7a3f;--good-bg:#e5f3ea;--warn:#8a5a00;--warn-bg:#fbf0d9;--bad:#b3261e;--bad-bg:#fbe5e3;--chip:#efeee9;--code:#f2f1ec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--panel:#1e1e1c;--text:#ebeae6;--muted:#a3a29b;--line:#34332f;--accent:#8aa8ff;--good:#7fd19b;--good-bg:#1d3326;--warn:#f0c46b;--warn-bg:#3a2f17;--bad:#ff9a92;--bad-bg:#3d1f1c;--chip:#2a2a27;--code:#191917}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px 64px}a{color:var(--accent)}h1{font-size:1.5rem;margin:.2em 0 .4em;line-height:1.25}
h2{font-size:1.1rem;margin:2rem 0 .75rem;padding-bottom:.35rem;border-bottom:1px solid var(--line)}h3{font-size:.95rem;margin:0}
.crumb{color:var(--muted);font-size:.85rem}.meta{color:var(--muted);font-size:.85rem;display:flex;flex-wrap:wrap;gap:.35rem 1rem;margin:.25rem 0}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:.75rem 0}
.badge{display:inline-block;font-size:.75rem;font-weight:600;padding:.05rem .5rem;border-radius:999px;background:var(--chip);color:var(--muted);white-space:nowrap}
.badge.good{background:var(--good-bg);color:var(--good)}.badge.warn{background:var(--warn-bg);color:var(--warn)}.badge.bad{background:var(--bad-bg);color:var(--bad)}
.chip{display:inline-block;font-size:.8rem;padding:.1rem .55rem;border-radius:6px;background:var(--chip);margin:.1rem .25rem .1rem 0}
pre{white-space:pre-wrap;word-break:break-word;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font:12.5px/1.45 ui-monospace,Consolas,monospace;max-height:70vh;overflow:auto;margin:.5rem 0}
details{margin:.35rem 0}summary{cursor:pointer;color:var(--accent);font-size:.88rem}
.grid{display:grid;gap:12px}.round-label{font-weight:600;margin:1.25rem 0 .25rem}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}
.card .top{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem;flex-wrap:wrap}.card .sum{margin:.45rem 0}
.nav{display:flex;gap:.75rem;align-items:center;margin-bottom:1rem;border-bottom:1px solid var(--line);padding-bottom:.5rem}
.nav a{text-decoration:none;padding:.2rem .65rem;border-radius:6px;font-size:.9rem;font-weight:600}
.nav a.active{background:var(--chip);color:var(--text)}
.quota-row{display:flex;align-items:center;gap:12px;margin:.55rem 0}
.chart-svg{width:100%;height:auto;display:block;margin-top:.35rem;background:var(--code);border:1px solid var(--line);border-radius:8px}
.alert{border-left:4px solid var(--warn);background:var(--warn-bg);padding:10px 14px;border-radius:8px;margin:.75rem 0}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.msg{border-left:3px solid var(--line);padding:.25rem 0 .25rem .9rem;margin:.9rem 0}.msg .who{font-weight:600}
.outcome{white-space:pre-wrap}.small{font-size:.82rem;color:var(--muted)}
@media (max-width:700px){.grid{grid-template-columns:1fr!important}th:nth-child(n+5),td:nth-child(n+5){display:none}}
`;

function page(title: string, body: string, note: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}<p class="small" style="margin-top:3rem">${esc(note)}</p></main></body></html>`;
}

export interface RenderOptions {
  /** live: link artifacts and rooms to the viewer's own pages; snapshot: embed artifact text so the file stands alone. */
  mode: 'live' | 'snapshot';
  artifact?: (handle: string) => ArtifactView | null;
  generatedAt?: string;
}

const navBar = (active: 'rooms' | 'status', options: RenderOptions) => options.mode === 'live'
  ? `<nav class="nav"><a href="/"${active === 'rooms' ? ' class="active"' : ''}>Rooms</a><a href="/status"${active === 'status' ? ' class="active"' : ''}>Status &amp; quota</a></nav>`
  : '';

export function renderRoomList(rooms: RoomSummary[], options: RenderOptions): string {
  const rows = rooms.map(r => `<tr><td><a href="/g/${esc(r.handle.slice(1))}">${esc(r.handle)}</a></td><td>${esc(r.subject)}</td>
<td>${r.seats.length ? r.seats.map(s => `<span class="chip">${esc(s.seat)}: ${esc(routeName(s.route))}</span>`).join('') : '<span class="small">discussion</span>'}</td>
<td>${badge(r.room_status ?? r.status)}${r.max_rounds ? ` <span class="small">r${r.round}/${r.max_rounds}</span>` : ''}</td>
<td>${r.jobs} jobs, ${r.messages} posts</td><td>${esc(r.project)}</td><td class="small">${esc(when(r.created_at))}</td></tr>`).join('\n');
  const body = `${navBar('rooms', options)}<div class="crumb">Agent Commons</div><h1>Rooms and discussions</h1>
<p class="small">Read-only. Newest first. Select a room to see each seat's jobs, replies, artifacts and outcome.</p>
<div class="panel" style="overflow-x:auto"><table><thead><tr><th>Room</th><th>Subject</th><th>Seats</th><th>Status</th><th>Activity</th><th>Project</th><th>Opened</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">No rooms yet.</td></tr>'}</tbody></table></div>`;
  return page('Agent Commons rooms', body, footer(options));
}

const footer = (options: RenderOptions) => options.mode === 'snapshot'
  ? `Snapshot generated ${when(options.generatedAt ?? new Date().toISOString())} from the Agent Commons database (read-only). It does not update.`
  : 'Read-only view of the Agent Commons database. Reload the page for the latest state.';

function artifactLink(handle: string, options: RenderOptions): string {
  return options.mode === 'live' ? `<a href="/a/${esc(handle.slice(1))}">${esc(handle)}</a>` : `<a href="#${esc(handle)}">${esc(handle)}</a>`;
}

function jobCard(job: JobView, options: RenderOptions): string {
  const facts = [routeName(job.route), job.model, job.effort && `${job.effort} effort`, job.turns != null && `${job.turns} turn${job.turns === 1 ? '' : 's'}`,
    duration(job.started_at, job.finished_at), job.cost_usd != null && `$${Number(job.cost_usd).toFixed(4)}`,
    (job.tokens_in || job.tokens_out) && `${job.tokens_in ?? 0} in / ${job.tokens_out ?? 0} out tokens`].filter(Boolean);
  const outcomes = job.outcomes.filter(o => o.kind !== 'consult_verdict');
  const ctx = job.ctx.map(c => { const a = /^art:(a\d+)$/.exec(c); return a ? artifactLink(a[1], options) : esc(c.replace(/^file:/, '')); });
  return `<div class="card" id="${esc(job.handle)}">
<div class="top"><h3>${esc(job.seat ?? job.handle)} <span class="small">${esc(job.handle)}</span></h3><span>${badge(job.status)} ${job.verdict ? badge(job.verdict, `verdict ${job.verdict}`) : ''}${job.confidence != null ? ` <span class="small">p=${job.confidence}</span>` : ''}</span></div>
<div class="meta">${facts.map(f => `<span>${esc(f)}</span>`).join('')}</div>
${job.summary ? `<div class="sum">${esc(job.summary)}</div>` : ''}${job.error ? `<div class="sum"><span class="badge bad">error</span> ${esc(job.error)}</div>` : ''}
${outcomes.map(o => `<div class="small">${badge(o.kind)} ${esc(o.detail ?? '')} <span>(${esc(o.actor)})</span></div>`).join('')}
${fold('Full reply', pre(job.result ?? '(no result)'))}
${fold(`Prompt sent (${kb(Buffer.byteLength(job.prompt))})`, pre(job.prompt))}
${ctx.length || job.ctx_artifact ? `<div class="small" style="margin-top:.35rem">Context: ${ctx.join(', ')}${job.ctx_artifact ? `; packed context ${artifactLink(job.ctx_artifact, options)}${job.ctx_chars ? ` (${job.ctx_chars.toLocaleString('en-US')} chars)` : ''}` : ''}</div>` : ''}
<div class="small">Started ${esc(when(job.started_at ?? job.created_at))} by ${esc(job.created_by)}${job.message ? `; posted as <a href="#${esc(job.message)}">${esc(job.message)}</a>` : ''}</div>
</div>`;
}

export function renderRoom(room: RoomView, options: RenderOptions): string {
  const seatNames = room.seats.length ? room.seats.map(s => String(s.seat)) : [...new Set(room.jobs.map(j => j.seat ?? j.handle))];
  const rounds = [...new Set(room.jobs.map(j => j.round ?? 0))].sort((a, b) => a - b);
  const columns = `grid-template-columns:repeat(${Math.max(1, Math.min(seatNames.length, 4))},minmax(0,1fr))`;
  const grid = rounds.map(r => {
    const cells = seatNames.map(seat => {
      const jobs = room.jobs.filter(j => (j.round ?? 0) === r && (j.seat ?? j.handle) === seat);
      return jobs.length ? jobs.map(j => jobCard(j, options)).join('') : `<div class="card small">${esc(seat)}: no job this round</div>`;
    });
    const extra = room.jobs.filter(j => (j.round ?? 0) === r && !seatNames.includes(j.seat ?? j.handle)).map(j => jobCard(j, options));
    return `<div class="round-label">Round ${r}</div><div class="grid" style="${columns}">${[...cells, ...extra].join('')}</div>`;
  }).join('');

  const seats = room.seats.map(s => `<span class="chip">${esc(s.seat)}: ${esc(routeName(s.route))}${s.eff ? `, ${esc(s.eff)}` : ''}${s.role && s.role !== s.seat ? ` (${esc(s.role)})` : ''}</span>`).join('');
  const messages = room.messages.map(m => `<div class="msg" id="${esc(m.handle)}"><div><span class="who">${esc(m.sender.replace(/^seat:/, 'seat '))}</span>
<span class="small"> ${esc(m.handle)}, ${esc(m.type)}, ${esc(when(m.created_at))}${m.confidence != null ? `, p=${m.confidence}` : ''}${m.evidence.length ? `, from ${m.evidence.map(e => /^j\d+$/.test(e) ? `<a href="#${esc(e)}">${esc(e)}</a>` : esc(e)).join(', ')}` : ''}${m.reply_to ? `, replying to <a href="#${esc(m.reply_to)}">${esc(m.reply_to)}</a>` : ''}</span></div>
${fold(esc(m.body.split('\n')[0].slice(0, 220)), pre(m.body))}</div>`).join('');

  const artifactRows = room.artifacts.map(a => `<tr><td>${artifactLink(a.handle, options)}</td><td>${esc(a.name)}</td><td>${esc(a.kind)}</td><td>${kb(a.bytes)}</td><td>${a.used_by.map(j => `<a href="#${esc(j)}">${esc(j)}</a>`).join(', ')}</td></tr>`).join('');
  const embedded = options.mode === 'snapshot' && options.artifact ? room.artifacts.map(a => {
    const view = options.artifact!(a.handle);
    const text = view?.content == null ? '(content not available)' : view.content.length > MAX_EMBED ? view.content.slice(0, MAX_EMBED) + '\n\n[cut at 300 KB]' : view.content;
    return `<div id="${esc(a.handle)}">${fold(`${esc(a.handle)} ${esc(a.name)} (${kb(a.bytes)})`, pre(text))}</div>`;
  }).join('') : '';

  const timeline = [
    ...room.events.map(e => ({ at: e.at, text: `${e.action.replace(/_/g, ' ')} by ${e.actor}` })),
    ...room.jobs.flatMap(j => [{ at: j.created_at, text: `${j.handle} (${j.seat ?? routeName(j.route)}, round ${j.round ?? '-'}) queued` },
      ...(j.finished_at ? [{ at: j.finished_at, text: `${j.handle} ${j.status}${j.verdict ? `, verdict ${j.verdict}` : ''}` }] : [])]),
    ...room.messages.map(m => ({ at: m.created_at, text: `${m.handle} posted by ${m.sender}` })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const totalCost = room.jobs.reduce((sum, j) => sum + (Number(j.cost_usd) || 0), 0);
  const body = `<div class="crumb">${options.mode === 'live' ? '<a href="/">Rooms</a> / ' : 'Agent Commons / '}${esc(room.project.name)}${room.project.handle ? ` (${esc(room.project.handle)})` : ''}</div>
<h1>${esc(room.handle)}: ${esc(room.subject)}</h1>
<div class="meta"><span>${badge(room.status)} ${badge(room.room_status)}</span>${room.mode ? `<span>${esc(room.mode)} room</span>` : '<span>discussion</span>'}${room.max_rounds ? `<span>round ${room.round} of ${room.max_rounds}</span>` : ''}
<span>owner ${esc(room.owner)}</span>${room.task ? `<span>task ${esc(room.task)}</span>` : ''}<span>opened ${esc(when(room.created_at))}</span>${room.closed_at ? `<span>closed ${esc(when(room.closed_at))}</span>` : ''}
<span>${room.jobs.length} jobs${totalCost ? `, $${totalCost.toFixed(4)}` : ''}</span></div>
${seats ? `<div style="margin:.5rem 0">${seats}</div>` : ''}
<div class="panel"><h3>Question</h3><div class="outcome">${esc(room.question)}</div></div>
${room.outcome ? `<div class="panel"><h3>Outcome</h3><div class="outcome">${esc(room.outcome)}</div></div>` : ''}
${room.jobs.length ? `<h2>Seats by round</h2>${grid}` : ''}
<h2>Conversation (${room.messages.length})</h2>${messages || '<p class="small">No posts.</p>'}
${room.artifacts.length ? `<h2>Artifacts (${room.artifacts.length})</h2><div class="panel" style="overflow-x:auto"><table><thead><tr><th>Artifact</th><th>Name</th><th>Kind</th><th>Size</th><th>Used by</th></tr></thead><tbody>${artifactRows}</tbody></table></div>${embedded}` : ''}
<h2>Timeline</h2><div class="panel"><table><tbody>${timeline.map(t => `<tr><td class="small" style="white-space:nowrap">${esc(when(t.at))}</td><td>${esc(t.text)}</td></tr>`).join('')}</tbody></table></div>`;
  return page(`${room.handle} ${room.subject}`, body, footer(options));
}

export function renderArtifact(view: ArtifactView): string {
  const body = `<div class="crumb"><a href="/">Rooms</a> / artifact</div><h1>${esc(view.handle)}: ${esc(view.name)}</h1>
<div class="meta"><span>${esc(view.kind)}</span><span>${kb(view.bytes)}</span><span>by ${esc(view.actor)}</span><span>${esc(when(view.created_at))}</span></div>
${pre(view.content ?? '(content not available)')}`;
  return page(`${view.handle} ${view.name}`, body, 'Read-only view of the Agent Commons database.');
}

/** The self-contained snapshot for room-report. */
export function roomReport(home: string, ref: string, generatedAt = new Date().toISOString()): string {
  const db = openViewerDb(home);
  try {
    const room = loadRoom(db, ref);
    if (!room) throw new Error(`no room or discussion ${ref}`);
    return renderRoom(room, { mode: 'snapshot', generatedAt, artifact: handle => loadArtifact(db, home, handle) });
  } finally { db.close(); }
}

export interface StatusRouteView {
  id: string;
  probeState: string;
  cliVersion: string | null;
  running: number;
  queued: number;
  cooldownUntil: string | null;
  cooldownReason: string | null;
  usageError: UsageDiagnostic | null;
  resetCredits: CodexResetSummary | null;
  windows: UsageWindow[];
}

export interface StatusJobView {
  handle: string;
  route: string;
  mode: string;
  model: string | null;
  effort: string | null;
  status: string;
  verdict: string | null;
  costUsd: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  roomHandle: string | null;
  error: string | null;
}

export interface StatusView {
  generatedAt: string;
  routes: StatusRouteView[];
  cycles: UsageHistoryCycle[];
  needsReview: StatusJobView[];
  recentJobs: StatusJobView[];
  healthProblems: Array<{ id: string; text: string }>;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(c => String(c.name)));
}

export function loadStatus(db: DatabaseSync, home: string, at = Date.now()): StatusView {
  const cols = tableColumns(db, 'platform_state');
  const hasScopeMeta = cols.has('usage_last_error') && cols.has('usage_meta');
  const perRoute = new Map<string, { running: number; queued: number }>();
  for (const r of db.prepare("SELECT route, sum(status='running') running, sum(status='queued') queued FROM jobs GROUP BY route").all() as Row[]) {
    perRoute.set(String(r.route), { running: Number(r.running ?? 0), queued: Number(r.queued ?? 0) });
  }
  const windowRows = tableExists(db, 'usage_windows')
    ? db.prepare('SELECT * FROM usage_windows ORDER BY route, pool, window').all() as Row[]
    : [];
  const windowsByRoute = new Map<string, UsageWindow[]>();
  for (const row of windowRows) {
    const stale = at - Date.parse(row.observed_at) > 6 * 60 * 60 * 1000
      || (row.resets_at !== null && Date.parse(row.resets_at) <= at);
    const markedClosed = String(row.source ?? '').endsWith(':closed');
    const w: UsageWindow = {
      route: row.route,
      pool: row.pool,
      window: row.window,
      remaining_percent: stale ? null : row.remaining_percent,
      resets_at: row.resets_at,
      observed_at: row.observed_at,
      source: markedClosed ? String(row.source).slice(0, -':closed'.length) : String(row.source),
      stale,
      ...(row.early_reset_observed_at ? { early_reset_observed_at: row.early_reset_observed_at, early_reset_scheduled_at: row.early_reset_scheduled_at } : {}),
      closed: markedClosed && row.resets_at !== null && Date.parse(row.resets_at) > at,
    };
    const list = windowsByRoute.get(w.route) ?? [];
    list.push(w);
    windowsByRoute.set(w.route, list);
  }

  const routes: StatusRouteView[] = (db.prepare('SELECT * FROM platform_state ORDER BY adapter_id').all() as Row[]).map(s => {
    const id = String(s.adapter_id);
    const counts = perRoute.get(id) ?? { running: 0, queued: 0 };
    const usageError = hasScopeMeta && s.usage_last_error ? parse(s.usage_last_error, null) : null;
    const meta = hasScopeMeta && s.usage_meta ? parse(s.usage_meta, null) : null;
    const activeCooldown = s.cooldown_until && Date.parse(s.cooldown_until) > at ? String(s.cooldown_until) : null;
    return {
      id,
      probeState: String(s.probe_state ?? 'unknown'),
      cliVersion: s.cli_version ? String(s.cli_version) : null,
      running: counts.running,
      queued: counts.queued,
      cooldownUntil: activeCooldown,
      cooldownReason: activeCooldown && s.cooldown_reason ? String(s.cooldown_reason) : null,
      usageError,
      resetCredits: meta?.resetCredits ?? null,
      windows: windowsByRoute.get(id) ?? [],
    };
  });

  const cycles: UsageHistoryCycle[] = [];
  if (tableExists(db, 'usage_history')) {
    const nowIso = new Date(at).toISOString();
    const oldestIso = new Date(at - 7 * 86_400_000).toISOString();
    const map = new Map<string, UsageHistoryCycle>();
    for (const r of db.prepare('SELECT route, pool, window, cycle_resets_at, observed_at, remaining_percent FROM usage_history WHERE cycle_resets_at > ? AND observed_at >= ? ORDER BY route, pool, window, cycle_resets_at, bucket_index').all(nowIso, oldestIso) as Row[]) {
      const winMs = windowLengthMs(String(r.window)) ?? 7 * 86_400_000;
      const key = JSON.stringify([r.route, r.pool, r.window, r.cycle_resets_at]);
      let c = map.get(key);
      if (!c) {
        c = {
          route: String(r.route), pool: String(r.pool), window: String(r.window),
          started_at: new Date(Date.parse(String(r.cycle_resets_at)) - winMs).toISOString(),
          resets_at: String(r.cycle_resets_at), points: [],
        };
        map.set(key, c);
      }
      c.points.push({ observed_at: String(r.observed_at), remaining_percent: Number(r.remaining_percent) });
    }
    cycles.push(...map.values());
  }

  const mapJob = (j: Row): StatusJobView => ({
    handle: 'j' + j.seq,
    route: String(j.route),
    mode: String(j.mode),
    model: j.reported_model ?? j.resolved_model ?? j.model ?? null,
    effort: j.resolved_eff ?? j.effort ?? null,
    status: String(j.status),
    verdict: j.consult_verdict ?? null,
    costUsd: j.cost_usd ?? null,
    createdAt: String(j.created_at),
    startedAt: j.started_at ?? null,
    finishedAt: j.finished_at ?? null,
    roomHandle: j.room_seq != null ? 'g' + j.room_seq : null,
    error: j.error ?? null,
  });

  const needsReview = (db.prepare(`SELECT j.*, d.seq room_seq FROM jobs j LEFT JOIN discussions d ON d.id=j.room_id
    WHERE j.status='needs_review' ORDER BY j.seq DESC LIMIT 20`).all() as Row[]).map(mapJob);
  const recentJobs = (db.prepare(`SELECT j.*, d.seq room_seq FROM jobs j LEFT JOIN discussions d ON d.id=j.room_id
    ORDER BY CASE WHEN j.status='running' THEN 0 WHEN j.status='queued' THEN 1 ELSE 2 END, j.seq DESC LIMIT 20`).all() as Row[]).map(mapJob);

  const healthProblems: Array<{ id: string; text: string }> = [];
  try {
    const raw = fs.readFileSync(path.join(home, 'health.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.problems)) {
      for (const p of parsed.problems) {
        if (p && typeof p.text === 'string') healthProblems.push({ id: String(p.id ?? 'health'), text: p.text });
      }
    }
  } catch { /* health.json is optional */ }

  return { generatedAt: new Date(at).toISOString(), routes, cycles, needsReview, recentJobs, healthProblems };
}

function paceRingSvg(window: UsageWindow, at: number): string {
  const remaining = window.closed ? 0 : window.remaining_percent;
  const pct = remaining === null || window.stale ? null : Math.min(100, Math.max(0, remaining));
  const pace = windowPace(window, at);
  const r = 24, cx = 32, cy = 32, circ = 2 * Math.PI * r;
  const dash = pct === null ? 0 : (pct / 100) * circ;
  const stroke = pct === null ? 'var(--muted)' : pct <= 15 || (pace && pace.pacePercent < 75) ? 'var(--warn)' : 'var(--good)';
  let tick = '';
  if (pace) {
    const angle = (-90 + (pace.remainingTimePercent / 100) * 360) * (Math.PI / 180);
    const x1 = (cx + (r - 5) * Math.cos(angle)).toFixed(1), y1 = (cy + (r - 5) * Math.sin(angle)).toFixed(1);
    const x2 = (cx + (r + 5) * Math.cos(angle)).toFixed(1), y2 = (cy + (r + 5) * Math.sin(angle)).toFixed(1);
    tick = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--text)" stroke-width="2" stroke-linecap="round"/>`;
  }
  const label = pct === null ? '?' : `${Math.round(pct)}%`;
  return `<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="6"/>
${pct !== null ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>` : ''}
${tick}
<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text)">${esc(label)}</text>
</svg>`;
}

function cycleChartSvg(cycle: UsageHistoryCycle): string {
  const startMs = Date.parse(cycle.started_at), resetMs = Date.parse(cycle.resets_at), span = Math.max(1, resetMs - startMs);
  const pts = downsamplePoints(cycle.points, 240);
  const w = 420, h = 110, padL = 28, padR = 10, padT = 10, padB = 18;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const coords = pts.map(pt => {
    const t = Math.min(1, Math.max(0, (Date.parse(pt.observed_at) - startMs) / span));
    const yVal = Math.min(100, Math.max(0, pt.remaining_percent));
    const x = padL + t * plotW;
    const y = padT + (1 - yVal / 100) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = coords[coords.length - 1].split(',');
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(cycle.route)} ${esc(cycle.pool)} ${esc(cycle.window)} cycle">
<line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}" stroke="var(--line)" stroke-width="1"/>
<line x1="${padL}" y1="${padT + plotH / 2}" x2="${w - padR}" y2="${padT + plotH / 2}" stroke="var(--line)" stroke-width="1" stroke-dasharray="2,3"/>
<line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" stroke="var(--line)" stroke-width="1"/>
<line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT + plotH}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4,4"/>
<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${coords.join(' ')}"/>
<circle cx="${last[0]}" cy="${last[1]}" r="3" fill="var(--accent)"/>
<text x="4" y="${padT + 4}" font-size="9" fill="var(--muted)">100%</text>
<text x="8" y="${padT + plotH / 2 + 3}" font-size="9" fill="var(--muted)">50%</text>
<text x="12" y="${padT + plotH}" font-size="9" fill="var(--muted)">0%</text>
<text x="${padL}" y="${h - 4}" font-size="9" fill="var(--muted)">Cycle start</text>
<text x="${w - padR}" y="${h - 4}" text-anchor="end" font-size="9" fill="var(--muted)">Reset</text>
</svg>`;
}

export function renderStatus(view: StatusView, options: RenderOptions): string {
  const at = Date.parse(view.generatedAt) || Date.now();
  const alerts: string[] = [];
  if (view.needsReview.length) alerts.push(`${view.needsReview.length} job(s) need review (${view.needsReview.map(j => j.handle).join(', ')}).`);
  for (const r of view.routes) {
    if (r.cooldownUntil) alerts.push(`${routeName(r.id)} in cooldown until ${when(r.cooldownUntil)}${r.cooldownReason ? ` (${r.cooldownReason})` : ''}.`);
    if (r.usageError) alerts.push(`${routeName(r.id)} last usage read failed: ${r.usageError.kind}${r.usageError.method ? ` (${r.usageError.method})` : ''}.`);
    if (r.resetCredits) {
      const rep = codexExpiringResets(r.resetCredits, 3, at);
      for (const exp of rep.expiring) {
        alerts.push(`${exp.count} Codex banked reset(s) expire in ${formatCompactDuration(exp.remainingMs)} (${when(exp.expiresAt)}).`);
      }
    }
  }
  for (const p of view.healthProblems) alerts.push(`${p.id}: ${p.text}`);

  const routeCards = view.routes.map(r => {
    const resetsReport = r.resetCredits ? codexExpiringResets(r.resetCredits, 3, at) : null;
    const winRows = r.windows.map(w => {
      const pace = formatPaceSummary(w, at);
      const resetIn = w.resets_at && Date.parse(w.resets_at) > at ? `resets in ${formatCompactDuration(Date.parse(w.resets_at) - at)}` : w.resets_at ? `reset ${when(w.resets_at)}` : 'no reset';
      return `<div class="quota-row">${paceRingSvg(w, at)}<div><div><strong>${esc(w.pool)} / ${esc(w.window)}</strong>${w.closed ? ` ${badge('failed', 'closed')}` : ''}</div>
<div class="small">${esc(resetIn)}${pace ? ` · ${esc(pace)}` : ''}</div>
<div class="small">Source: ${esc(w.source)} · ${esc(when(w.observed_at))}</div></div></div>`;
    }).join('');
    return `<div class="card"><div class="top"><h3>${esc(routeName(r.id))}</h3><span>${badge(r.probeState)}</span></div>
<div class="meta">${r.cliVersion ? `<span>${esc(r.cliVersion)}</span>` : ''}<span>running ${r.running}, queued ${r.queued}</span></div>
${r.cooldownUntil ? `<div class="small" style="margin:.35rem 0">${badge('needs_review', 'cooldown')} until ${esc(when(r.cooldownUntil))}</div>` : ''}
${resetsReport && resetsReport.remainingCount > 0 ? `<div class="small" style="margin:.35rem 0">${badge(resetsReport.expiring.length ? 'needs_review' : 'ok', `${resetsReport.remainingCount} banked reset(s)`)}${resetsReport.nextExpiry ? ` next expires ${esc(when(resetsReport.nextExpiry))}` : ''}</div>` : ''}
${r.usageError ? `<div class="small" style="margin:.35rem 0">${badge('failed', 'usage error')} ${esc(r.usageError.kind)}${r.usageError.method ? ` (${esc(r.usageError.method)})` : ''} at ${esc(when(r.usageError.at))}</div>` : ''}
${winRows || '<p class="small">No usage windows recorded.</p>'}</div>`;
  }).join('');

  const weeklyCycles = view.cycles.filter(c => c.points.length >= 2 && (windowLengthMs(c.window) ?? 0) >= 24 * 3600_000);
  const cycleCards = weeklyCycles.map(c => `<div class="card"><div class="top"><h3>${esc(routeName(c.route))}: ${esc(c.pool)} / ${esc(c.window)}</h3><span class="small">${c.points.length} pts</span></div>
<div class="small">Resets ${esc(when(c.resets_at))}</div>${cycleChartSvg(c)}</div>`).join('');

  const jobRows = view.recentJobs.map(j => {
    const room = j.roomHandle ? (options.mode === 'live' ? `<a href="/g/${esc(j.roomHandle.slice(1))}">${esc(j.roomHandle)}</a>` : esc(j.roomHandle)) : '<span class="small">-</span>';
    return `<tr><td>${esc(j.handle)}</td><td>${esc(routeName(j.route))}</td><td>${esc(j.model ?? '-')}${j.effort ? ` <span class="small">${esc(j.effort)}</span>` : ''}</td>
<td>${badge(j.status)}${j.verdict ? ` ${badge(j.verdict)}` : ''}</td><td>${esc(duration(j.startedAt, j.finishedAt) || '-')}</td>
<td>${j.costUsd != null ? `$${Number(j.costUsd).toFixed(4)}` : '-'}</td><td>${room}</td><td class="small">${esc(when(j.createdAt))}</td></tr>`;
  }).join('\n');

  const body = `${navBar('status', options)}<div class="crumb">Agent Commons</div><h1>Status and quota</h1>
${alerts.length ? `<div class="alert"><strong>Needs attention</strong><ul>${alerts.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
<h2>Routes and quota pace</h2>
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">${routeCards || '<p class="small">No routes recorded.</p>'}</div>
${cycleCards ? `<h2>Quota cycle curves</h2><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr))">${cycleCards}</div>` : ''}
<h2>Active and recent jobs</h2>
<div class="panel" style="overflow-x:auto"><table><thead><tr><th>Job</th><th>Route</th><th>Model</th><th>Status</th><th>Duration</th><th>Cost</th><th>Room</th><th>Created</th></tr></thead>
<tbody>${jobRows || '<tr><td colspan="8">No jobs yet.</td></tr>'}</tbody></table></div>`;
  return page('Agent Commons status', body, footer(options));
}

/** The self-contained snapshot for status-report. */
export function statusReport(home: string, generatedAt = new Date().toISOString()): string {
  const db = openViewerDb(home);
  try {
    return renderStatus(loadStatus(db, home, Date.parse(generatedAt) || Date.now()), { mode: 'snapshot', generatedAt });
  } finally { db.close(); }
}

// ---- live viewer ------------------------------------------------------------------------------------------------

export interface Viewer { url: string; token: string; close(): Promise<void> }

/**
 * Serves the read-only pages on 127.0.0.1. A per-start token (in the printed URL, then an HttpOnly SameSite=Strict
 * cookie) keeps other local pages and processes out, and the Host check blocks DNS rebinding. GET and HEAD only.
 */
export async function startViewer(home: string, port = VIEWER_PORT): Promise<Viewer> {
  const db = openViewerDb(home);
  const token = randomBytes(24).toString('hex');
  const same = (value: string | undefined) => !!value && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const server = http.createServer((request, response) => {
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", ...headers });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(String(request.headers.host ?? ''))) return send(421, 'Wrong host');
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, 'Read-only', { allow: 'GET, HEAD' });
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${actualPort}`);
    const key = url.searchParams.get('k') ?? undefined;
    if (same(key)) {
      url.searchParams.delete('k');
      return send(303, '', { location: url.pathname + url.search, 'set-cookie': `acv=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }
    const cookie = /(?:^|;\s*)acv=([0-9a-f]+)/.exec(String(request.headers.cookie ?? ''))?.[1];
    if (!same(cookie)) return send(401, page('Sign-in needed', '<h1>Open the link the viewer printed</h1><p>This viewer only accepts the link with its start key, which the <code>view</code> command printed.</p>', ''));
    try {
      let m: RegExpExecArray | null;
      if (url.pathname === '/') return send(200, renderRoomList(listRooms(db), { mode: 'live' }));
      if (url.pathname === '/status') return send(200, renderStatus(loadStatus(db, home), { mode: 'live' }));
      if ((m = /^\/g\/(\d+)$/.exec(url.pathname))) {
        const room = loadRoom(db, 'g' + m[1]);
        return room ? send(200, renderRoom(room, { mode: 'live' })) : send(404, page('Not found', '<h1>No such room</h1><p><a href="/">All rooms</a></p>', ''));
      }
      if ((m = /^\/a\/(\d+)$/.exec(url.pathname))) {
        const view = loadArtifact(db, home, 'a' + m[1]);
        return view ? send(200, renderArtifact(view)) : send(404, page('Not found', '<h1>No such artifact</h1><p><a href="/">All rooms</a></p>', ''));
      }
      return send(404, page('Not found', '<h1>Not found</h1><p><a href="/">All rooms</a></p>', ''));
    } catch (error) {
      return send(500, page('Error', `<h1>Could not read the database</h1>${pre((error as Error).message)}`, ''));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}/?k=${token}`, token,
    close: () => new Promise<void>(resolve => { server.close(() => { try { db.close(); } catch {} resolve(); }); server.closeAllConnections(); }),
  };
}

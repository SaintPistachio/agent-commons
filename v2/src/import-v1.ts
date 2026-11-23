import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Store, Json } from './store.ts';

/** v1 task statuses mapped to v2. Unknown values become 'open' and are counted. */
const STATUS: Record<string, string> = {
  ready: 'open', assigned: 'in_progress', running: 'in_progress', blocked: 'blocked', awaiting_review: 'awaiting_review',
  accepted: 'done', advisory_resolved: 'done', completed: 'done', cancelled: 'cancelled',
};
const MESSAGE_TYPE: Record<string, string> = { question: 'question', answer: 'reply', reply: 'reply', post: 'post' };

/** v1 list items may be objects (for example checks with command/evidence/exit_code); keep them readable as text. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && 'command' in item) {
      const check = item as Json;
      return `${check.command} -> ${check.evidence ?? ''}${check.exit_code !== undefined ? ` (exit ${check.exit_code})` : ''}`.trim();
    }
    return JSON.stringify(item);
  });
}
const str = (value: unknown) => typeof value === 'string' && value.length ? value : null;

export interface ImportReport { counts: Record<string, number>; skipped: Record<string, number>; notes: string[] }

/**
 * Copies continuity records from a v1 home into an empty v2 store. v1 is opened
 * read-only and is not modified. IDs and token hashes are kept, so existing
 * connection files work against v2 once their url points at it.
 */
export function importV1(v1Home: string, store: Store): ImportReport {
  const v1 = new DatabaseSync(path.join(v1Home, 'commons.sqlite'), { readOnly: true });
  const report: ImportReport = { counts: {}, skipped: {}, notes: [] };
  const count = (kind: string) => { report.counts[kind] = (report.counts[kind] ?? 0) + 1; };
  const skip = (kind: string) => { report.skipped[kind] = (report.skipped[kind] ?? 0) + 1; };
  try {
    if (store.db.prepare('SELECT 1 FROM projects LIMIT 1').get() || store.db.prepare('SELECT 1 FROM actors LIMIT 1').get())
      throw new Error('IMPORT_TARGET_NOT_EMPTY');
    const records = (kind: string) => (v1.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind) as Json[]).map(row => JSON.parse(row.data));
    const db = store.db;
    store.transaction(() => {
      for (const row of v1.prepare('SELECT id,token_hash,data FROM actors').all() as Json[]) {
        const data = JSON.parse(row.data);
        db.prepare('INSERT INTO actors(id,name,role,token_sha256,created_at) VALUES(?,?,?,?,?)')
          .run(row.id, row.id, data.role === 'operator' ? 'operator' : 'participant', row.token_hash, new Date().toISOString());
        count('actor');
      }
      const roots = new Set<string>();
      const projects = new Set<string>();
      for (const p of records('project')) {
        let root = str(p.root) ? path.resolve(p.root) : null;
        if (root && roots.has(root)) { report.notes.push(`project ${p.id} shares root ${root}; imported without root`); root = null; }
        if (root) roots.add(root);
        db.prepare('INSERT INTO projects(id,name,objective,root,next_action,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(p.id, p.name ?? p.id, p.objective ?? '', root, null, p.created_at, p.created_at);
        projects.add(p.id); count('project');
      }
      const tasks = new Set<string>();
      for (const t of records('task')) {
        if (!projects.has(t.project_id)) { skip('task'); continue; }
        const status = STATUS[t.status] ?? 'open';
        if (!STATUS[t.status]) report.notes.push(`task ${t.id} had unknown status ${t.status}`);
        db.prepare(`INSERT INTO tasks(id,project_id,title,objective,acceptance,status,owner,next_action,version,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(t.id, t.project_id, t.title ?? '(untitled)', t.objective ?? '', JSON.stringify(strings(t.acceptance)),
          status, str(t.owner), str(t.next_action), Number.isSafeInteger(t.version) && t.version > 0 ? t.version : 1, str(t.owner) ?? 'v1-import',
          t.created_at, t.updated_at ?? t.created_at);
        tasks.add(t.id); count('task');
      }
      const taskRef = (id: unknown) => typeof id === 'string' && tasks.has(id) ? id : null;
      for (const d of records('decision')) {
        if (!projects.has(d.project_id)) { skip('decision'); continue; }
        db.prepare('INSERT INTO decisions(id,project_id,task_id,actor_id,summary,rationale,evidence,supersedes,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(d.id, d.project_id, taskRef(d.task_id), d.actor_id ?? 'unknown', d.summary ?? '', d.rationale ?? '', JSON.stringify(strings(d.evidence)),
            str(d.supersedes), d.created_at);
        count('decision');
      }
      const artifacts = new Set<string>();
      const v1Artifacts = path.join(v1Home, 'artifacts'), v2Artifacts = path.join(store.home, 'artifacts');
      for (const a of records('artifact')) {
        if (!projects.has(a.project_id)) { skip('artifact'); continue; }
        const source = path.join(v1Artifacts, a.sha256), target = path.join(v2Artifacts, a.sha256);
        if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target);
        if (!fs.existsSync(target)) report.notes.push(`artifact ${a.id} content missing in v1`);
        db.prepare('INSERT INTO artifacts(id,project_id,actor_id,name,kind,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(a.id, a.project_id, a.actor_id ?? 'unknown', a.name ?? a.id, a.kind ?? 'text', a.sha256, a.bytes ?? 0, a.created_at);
        artifacts.add(a.id); count('artifact');
      }
      for (const c of records('checkpoint')) {
        if (!projects.has(c.project_id)) { skip('checkpoint'); continue; }
        db.prepare(`INSERT INTO checkpoints(id,project_id,task_id,actor_id,revision,branch,summary,next_action,checks,open_questions,artifacts,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.id, c.project_id, taskRef(c.task_id), c.actor_id ?? 'unknown', str(c.revision), str(c.branch),
          c.summary ?? '', str(c.next_action), JSON.stringify(strings(c.checks)), JSON.stringify(strings(c.open_questions)),
          JSON.stringify((Array.isArray(c.artifacts) ? c.artifacts : []).filter((id: unknown) => typeof id === 'string' && artifacts.has(id))), c.created_at);
        count('checkpoint');
      }
      // Project next action: the latest project-level checkpoint's next action.
      db.exec(`UPDATE projects SET next_action=(SELECT next_action FROM checkpoints c WHERE c.project_id=projects.id AND c.next_action IS NOT NULL ORDER BY (c.task_id IS NULL) DESC, seq DESC LIMIT 1),
        updated_at=COALESCE((SELECT max(created_at) FROM checkpoints c WHERE c.project_id=projects.id), updated_at)`);
      const discussions = new Set<string>();
      for (const d of records('discussion')) {
        if (!projects.has(d.project_id)) { skip('discussion'); continue; }
        db.prepare('INSERT INTO discussions(id,project_id,task_id,owner,subject,question,status,outcome,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(d.id, d.project_id, taskRef(d.task_id), d.owner ?? 'unknown', d.subject ?? '(no subject)', d.question ?? '', d.status === 'open' ? 'open' : 'closed', null, d.created_at);
        discussions.add(d.id); count('discussion');
      }
      for (const m of records('message')) {
        const type = MESSAGE_TYPE[m.type];
        if (!projects.has(m.project_id) || !type) { skip('message'); continue; }
        db.prepare('INSERT INTO messages(id,project_id,task_id,discussion_id,sender_id,recipients,type,body,reply_to,evidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(m.id, m.project_id, taskRef(m.task_id), discussions.has(m.discussion_id) ? m.discussion_id : null, m.sender_id ?? 'unknown',
            JSON.stringify(strings(m.recipients)), type, m.body ?? '', str(m.reply_to), JSON.stringify(strings(m.evidence)), m.created_at);
        for (const [field, kind] of [['acknowledged_by', 'ack'], ['answered_by', 'answered']] as const)
          for (const actor of strings(m[field])) db.prepare('INSERT OR REPLACE INTO message_acks(message_id,actor_id,kind,at) VALUES(?,?,?,?)').run(m.id, actor, kind, m.created_at);
        count('message');
      }
      // AIR-T short handles (p1, a1 ...) for the imported projects and artifacts, in creation order.
      for (const [kind, table] of [['p', 'projects'], ['a', 'artifacts']] as const)
        db.prepare(`INSERT INTO short_ids(kind,num,id) SELECT ?, (SELECT COALESCE(MAX(num),0) FROM short_ids WHERE kind=?) + row_number() OVER (ORDER BY created_at, id), id
          FROM ${table} WHERE id NOT IN (SELECT id FROM short_ids)`).run(kind, kind);
    });
    report.notes.push('Jobs, delegations, reviews, routing and service-issue records were not imported; v1 keeps them.');
    return report;
  } finally { v1.close(); }
}

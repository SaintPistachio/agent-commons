import type { DatabaseSync } from 'node:sqlite';

export const CALLER_OUTCOMES = ['accepted', 'rejected', 'redone', 'applied', 'verify_pass', 'verify_fail'] as const;
export type CallerOutcome = typeof CALLER_OUTCOMES[number];

export function appendOutcome(db: DatabaseSync, job: string, kind: CallerOutcome, detail: string, actor: string): void {
  db.prepare('INSERT INTO job_outcomes(job_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)')
    .run(job, kind, detail, actor, new Date().toISOString());
}

/** A consult's recommendation is evidence of what it said, not evidence of acceptance. */
export function recordConsultOutcome(db: DatabaseSync, job: string, actor: string): void {
  db.prepare(`INSERT INTO job_outcomes(job_id,kind,detail,actor_id,created_at)
    SELECT id,'consult_verdict',consult_verdict,?,? FROM jobs
    WHERE id=? AND status='completed' AND consult_verdict IS NOT NULL
    ON CONFLICT DO NOTHING`).run(actor, new Date().toISOString(), job);
}

type Configuration = {
  route: string; intent: string; eff: string; model: string; nativeEffort: string | null; mode: string;
};
const DAY = 86_400_000;

/**
 * Compare the latest explicit decision per job, preferring exact `(route, intent, eff, model, nativeEffort, mode)`.
 * When that exact slice has fewer than 10 samples (or <9 effective), falls back across efforts for the same
 * `(route, intent, model, mode)` with a stronger `(accepted + 2) / (weight + 4)` prior; unreported and mismatched
 * models are never pooled.
 */
export function acceptanceHistory(db: DatabaseSync, c: Configuration, at = Date.now()): { n: number; rate: number | null } {
  const minDate = new Date(at - 365 * DAY).toISOString();
  const maxDate = new Date(at).toISOString();
  const score = (rows: { kind: string; created_at: string }[], priorAccepted: number, priorTotal: number) => {
    let weight = 0, accepted = 0, squared = 0;
    for (const row of rows) {
      const w = 2 ** (-(at - Date.parse(row.created_at)) / (90 * DAY));
      weight += w;
      squared += w * w;
      if (row.kind === 'accepted') accepted += w;
    }
    const effective = squared ? weight * weight / squared : 0;
    return { n: rows.length, rate: rows.length >= 10 && effective >= 9 ? (accepted + priorAccepted) / (weight + priorTotal) : null };
  };
  const exact = db.prepare(`
    SELECT o.kind, o.created_at
    FROM jobs j JOIN job_outcomes o ON o.id=(
      SELECT max(id) FROM job_outcomes WHERE job_id=j.id AND kind IN ('accepted','rejected')
    )
    WHERE j.route=? AND j.req_intent=? AND j.req_eff=? AND j.resolved_model=? AND j.resolved_eff IS ?
      AND j.mode=? AND j.status='completed' AND (j.reported_model IS NULL OR j.reported_model=j.resolved_model)
      AND o.created_at>=? AND o.created_at<=?
  `).all(c.route, c.intent, c.eff, c.model, c.nativeEffort, c.mode, minDate, maxDate) as { kind: string; created_at: string }[];
  const exactScore = score(exact, 1, 2);
  if (exactScore.rate !== null) return exactScore;
  // Hierarchical fallback across efforts for the same route, intent, model, and mode with a stronger conservative prior.
  const broader = db.prepare(`
    SELECT o.kind, o.created_at
    FROM jobs j JOIN job_outcomes o ON o.id=(
      SELECT max(id) FROM job_outcomes WHERE job_id=j.id AND kind IN ('accepted','rejected')
    )
    WHERE j.route=? AND j.req_intent=? AND j.resolved_model=? AND j.mode=?
      AND j.status='completed' AND (j.reported_model IS NULL OR j.reported_model=j.resolved_model)
      AND o.created_at>=? AND o.created_at<=?
  `).all(c.route, c.intent, c.model, c.mode, minDate, maxDate) as { kind: string; created_at: string }[];
  return score(broader, 2, 4);
}

/** Machine observations are constrained telemetry, not a way to upload commands, logs or environment variables. */
export function applyEvidenceDetail(kind: CallerOutcome, detail: string): string | null {
  if (kind !== 'applied' && kind !== 'verify_pass' && kind !== 'verify_fail') return detail;
  let data: Record<string, unknown>;
  try { data = JSON.parse(detail); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const hash = (v: unknown, pattern: RegExp) => typeof v === 'string' && pattern.test(v);
  const revision = data.revision;
  if (revision !== null && !hash(revision, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)) return null;
  if (!hash(data.result_sha256, /^[a-f0-9]{64}$/) || typeof data.partial !== 'boolean') return null;
  const common = { revision, result_sha256: data.result_sha256, partial: data.partial };
  if (kind === 'applied') {
    if (!count(data.edits) || !count(data.files) || !count(data.deletes) || !data.files) return null;
    return JSON.stringify({ ...common, edits: data.edits, files: data.files, deletes: data.deletes });
  }
  const code = data.exit_code;
  if (!(code === null || count(code)) || (kind === 'verify_pass' && code !== 0)
    || !hash(data.command_sha256, /^[a-f0-9]{64}$/) || !hash(data.environment, /^[\w.-]{1,100}$/)) return null;
  return JSON.stringify({ ...common, exit_code: code, command_sha256: data.command_sha256, environment: data.environment });
}

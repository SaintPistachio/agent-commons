/** Plain US English for the project activity feed (`air-decode`), so people never need to read AIR-T. */

type Row = Record<string, any>;

const VERBS: Record<string, string> = {
  project_create: 'created project', project_checkpoint: 'published checkpoint', task_create: 'created task', task_claim: 'claimed task',
  task_update: 'updated task', task_release: 'released task', decision_record: 'recorded decision', team_ask: 'asked', team_reply: 'replied',
  discussion_open: 'opened discussion', discussion_post: 'posted in discussion', discussion_close: 'closed discussion',
  artifact_submit: 'stored artifact', art_put: 'stored artifact', consult_report: 'reported', room_step: 'ran a round in room', room_post: 'posted a seat reply', room_status: 'room round finished:', job_context: 'saved job context', job_output: 'saved job output', job_diff: 'saved job diff', job_submit: 'submitted job', job_cancel: 'cancelled job', job_settle: 'settled job', job_status: 'job changed status:',
};

const cut = (s: unknown, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '...' : t; };

/**
 * One sentence per event. `row` is the entity as it is now (it may have changed since the event),
 * `actor` is the display name of whoever acted.
 */
export function describe(event: Row, row: Row | undefined, actor: string): string {
  const when = String(event.created_at).replace('T', ' ').slice(0, 16) + 'Z';
  const verb = VERBS[event.action] ?? event.action;
  const subject = !row ? '(no longer present)'
    : event.kind === 'task' ? `"${cut(row.title)}" (now ${row.status}, version ${row.version})`
    : event.kind === 'decision' ? `"${cut(row.summary)}"`
    : event.kind === 'checkpoint' ? `"${cut(row.summary)}"`
    : event.kind === 'discussion' ? `"${cut(row.subject)}" (${row.status})`
    : event.kind === 'message' ? `${row.type === 'question' ? 'a question' : row.type === 'reply' ? 'a reply' : 'a post'}: "${cut(row.body)}"`
    : event.kind === 'artifact' ? `"${cut(row.name)}" (${row.bytes} bytes)`
    : event.kind === 'job' ? `on the ${row.route} route (${row.status})`
    : event.kind === 'project' ? `"${cut(row.name)}"`
    : '';
  return `#${event.seq} ${when} ${actor} ${verb} ${event.handle} ${subject}`.replace(/\s+$/, '');
}

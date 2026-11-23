import type { DatabaseSync } from 'node:sqlite';
import { backfillMemoryIndex } from './recall.ts';

export const SCHEMA_VERSION = 23;

/** Small normalized rows; list fields are JSON arrays of short strings. Each step upgrades one version. */
export function migrate(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version > SCHEMA_VERSION) throw new Error('SCHEMA_TOO_NEW');
  if (version < 1) db.exec(`
    CREATE TABLE IF NOT EXISTS actors(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('operator','participant')),
      token_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '', root TEXT,
      next_action TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS projects_root ON projects(root) WHERE root IS NOT NULL;
    CREATE TABLE IF NOT EXISTS tasks(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('open','in_progress','blocked','awaiting_review','done','cancelled')),
      owner TEXT, next_action TEXT, version INTEGER NOT NULL, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, status);
    CREATE TABLE IF NOT EXISTS decisions(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT, actor_id TEXT NOT NULL, summary TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '[]', supersedes TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS decisions_project ON decisions(project_id, seq);
    CREATE TABLE IF NOT EXISTS checkpoints(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT, actor_id TEXT NOT NULL, revision TEXT, branch TEXT, summary TEXT NOT NULL, next_action TEXT,
      checks TEXT NOT NULL DEFAULT '[]', open_questions TEXT NOT NULL DEFAULT '[]', artifacts TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS checkpoints_project ON checkpoints(project_id, seq);
    CREATE INDEX IF NOT EXISTS checkpoints_task ON checkpoints(task_id, seq);
    CREATE TABLE IF NOT EXISTS discussions(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT, owner TEXT NOT NULL, subject TEXT NOT NULL, question TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','closed')), outcome TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT, discussion_id TEXT, sender_id TEXT NOT NULL, recipients TEXT NOT NULL DEFAULT '[]',
      type TEXT NOT NULL CHECK(type IN ('question','reply','post')), body TEXT NOT NULL, reply_to TEXT,
      evidence TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_project ON messages(project_id, seq);
    CREATE TABLE IF NOT EXISTS message_acks(
      message_id TEXT NOT NULL, actor_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('ack','answered')),
      at TEXT NOT NULL, PRIMARY KEY(message_id, actor_id));
    CREATE TABLE IF NOT EXISTS artifacts(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), actor_id TEXT NOT NULL,
      name TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations(
      actor_id TEXT NOT NULL, method TEXT NOT NULL, id TEXT NOT NULL, input_sha256 TEXT NOT NULL,
      result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(actor_id, method, id));
    CREATE TABLE IF NOT EXISTS legacy_ids(
      kind TEXT NOT NULL, legacy_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind, legacy_id));
    PRAGMA user_version = 1;
  `);
  if (version < 2) db.exec(`
    CREATE TABLE IF NOT EXISTS jobs(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT,
      route TEXT NOT NULL CHECK(route IN ('claude')), mode TEXT NOT NULL CHECK(mode IN ('advice','edit')),
      prompt TEXT NOT NULL, model TEXT, effort TEXT, timeout_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','needs_review')),
      cancel_requested INTEGER NOT NULL DEFAULT 0, workdir TEXT, branch TEXT, base_revision TEXT, pid INTEGER, exit_code INTEGER,
      result TEXT, changed_files TEXT NOT NULL DEFAULT '[]', error TEXT, turns INTEGER, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, seq);
    CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id, seq);
    PRAGMA user_version = 2;
  `);
  // v3: the openai-api route. SQLite cannot change a CHECK constraint, so the table is rebuilt with its rows.
  if (version < 3) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE jobs_v3(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT,
          route TEXT NOT NULL CHECK(route IN ('claude','openai-api')), mode TEXT NOT NULL CHECK(mode IN ('advice','edit')),
          prompt TEXT NOT NULL, model TEXT, effort TEXT, timeout_ms INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','needs_review')),
          cancel_requested INTEGER NOT NULL DEFAULT 0, workdir TEXT, branch TEXT, base_revision TEXT, pid INTEGER, exit_code INTEGER,
          result TEXT, changed_files TEXT NOT NULL DEFAULT '[]', error TEXT, turns INTEGER, created_by TEXT NOT NULL,
          created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
          options TEXT NOT NULL DEFAULT '{}', helper_job_id TEXT, cost_usd TEXT);
        INSERT INTO jobs_v3(seq,id,project_id,task_id,route,mode,prompt,model,effort,timeout_ms,status,cancel_requested,workdir,branch,base_revision,
          pid,exit_code,result,changed_files,error,turns,created_by,created_at,started_at,finished_at)
          SELECT seq,id,project_id,task_id,route,mode,prompt,model,effort,timeout_ms,status,cancel_requested,workdir,branch,base_revision,
          pid,exit_code,result,changed_files,error,turns,created_by,created_at,started_at,finished_at FROM jobs;
        DROP TABLE jobs;
        ALTER TABLE jobs_v3 RENAME TO jobs;
        CREATE INDEX jobs_status ON jobs(status, seq);
        CREATE INDEX jobs_project ON jobs(project_id, seq);
        PRAGMA user_version = 3;
      `);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v4: routes are validated by job_submit, not a CHECK, so adding a route needs no table rebuild.
  if (version < 4) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const columns = (db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map(c => c.name).join(',');
      const create = String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get() as { sql: string }).sql);
      const rebuilt = create.replace(/CREATE TABLE "?jobs"?\s*\(/, 'CREATE TABLE jobs_v4(').replace(/route TEXT NOT NULL CHECK\(route IN \([^)]*\)\)/, 'route TEXT NOT NULL');
      if (rebuilt.includes('CHECK(route')) throw new Error('jobs route constraint not found');
      db.exec(rebuilt);
      db.exec(`INSERT INTO jobs_v4(${columns}) SELECT ${columns} FROM jobs; DROP TABLE jobs; ALTER TABLE jobs_v4 RENAME TO jobs;
        CREATE INDEX jobs_status ON jobs(status, seq); CREATE INDEX jobs_project ON jobs(project_id, seq); PRAGMA user_version = 4;`);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v5 (AIR-T, M3a): short handles for projects and artifacts (other kinds use their seq), a confidence value,
  // the project activity feed (events) and each actor's read position per project. Additive only.
  if (version < 5) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS short_ids(
          kind TEXT NOT NULL CHECK(kind IN ('p','a')), num INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, PRIMARY KEY(kind, num));
        ALTER TABLE decisions ADD COLUMN confidence REAL;
        ALTER TABLE messages ADD COLUMN confidence REAL;
        ALTER TABLE checkpoints ADD COLUMN confidence REAL;
        CREATE TABLE IF NOT EXISTS events(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('project','task','decision','checkpoint','discussion','message','artifact','job')),
          action TEXT NOT NULL, entity_id TEXT NOT NULL, handle TEXT NOT NULL, actor_id TEXT NOT NULL,
          air_line TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_project_seq ON events(project_id, seq);
        CREATE TABLE IF NOT EXISTS actor_cursors(
          actor_id TEXT NOT NULL REFERENCES actors(id), project_id TEXT NOT NULL REFERENCES projects(id),
          last_seq INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(actor_id, project_id));
        INSERT INTO short_ids(kind, num, id) SELECT 'p', row_number() OVER (ORDER BY created_at, id), id FROM projects;
        INSERT INTO short_ids(kind, num, id) SELECT 'a', row_number() OVER (ORDER BY created_at, id), id FROM artifacts;
        PRAGMA user_version = 5;`);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v6 (fabric Stage 2b): each platform's probed state, its intent/eff -> native model/effort profiles (seeded by the
  // adapters, editable by the operator), app presence, job usage columns and task dependencies. Additive only.
  if (version < 6) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS platform_state(
          adapter_id TEXT PRIMARY KEY, family TEXT NOT NULL, billing TEXT NOT NULL CHECK(billing IN ('local','sub','paid')),
          probe_state TEXT NOT NULL CHECK(probe_state IN ('verified','drifted','blocked','unavailable')),
          binary_sha256 TEXT, cli_version TEXT, help_sha256 TEXT, available_models TEXT NOT NULL DEFAULT '[]', reason TEXT,
          cooldown_until TEXT, cooldown_reason TEXT, last_probe_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS platform_profiles(
          adapter_id TEXT NOT NULL, intent TEXT NOT NULL CHECK(intent IN ('fast','code','review','deep','edit')),
          eff TEXT NOT NULL CHECK(eff IN ('min','low','med','high','max')), native_model TEXT, native_effort TEXT,
          native_options TEXT NOT NULL DEFAULT '{}', priority INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL, PRIMARY KEY(adapter_id, intent, eff));
        CREATE TABLE IF NOT EXISTS actor_presence(
          actor_id TEXT PRIMARY KEY REFERENCES actors(id), family TEXT, adapter_id TEXT, last_seen_at TEXT NOT NULL, last_project_id TEXT);`);
      // Each column only when missing, so the step is safe to run again.
      const add = (table: string, column: string, type: string) => {
        if (!(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      };
      for (const column of ['req_intent', 'req_eff', 'resolved_model', 'resolved_eff', 'reported_model', 'adapter_version']) add('jobs', column, 'TEXT');
      for (const column of ['tokens_in', 'tokens_out', 'latency_ms']) add('jobs', column, 'INTEGER');
      add('tasks', 'depends_on', "TEXT NOT NULL DEFAULT '[]'");
      db.exec('PRAGMA user_version = 6');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v7 (ops hardening): archived projects leave discovery; actors carry a model family and backing adapter, for
  // cross-family review and wake-up. Additive only.
  if (version < 7) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumn(db, 'projects', 'archived', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'actors', 'family', 'TEXT');
      addColumn(db, 'actors', 'adapter_id', 'TEXT');
      db.exec('PRAGMA user_version = 7');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v8 (Phase 5a, consult triggers): a task's review policy (none or cross), failed checkpoints (for the two-strike
  // hint), and on jobs the consult trigger, its depth, its parent job and the reviewer's verdict. Additive only.
  if (version < 8) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumn(db, 'tasks', 'review_policy', "TEXT NOT NULL DEFAULT 'none'");
      addColumn(db, 'checkpoints', 'failed', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'jobs', 'trigger', 'TEXT');
      addColumn(db, 'jobs', 'wake_depth', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'jobs', 'parent_job_id', 'TEXT');
      addColumn(db, 'jobs', 'consult_verdict', 'TEXT');
      db.exec('PRAGMA user_version = 8');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v9 (Phase 5b, working rooms): a discussion can be a room with seats, a mode, a round counter and limit, and a
  // status; seat jobs link to their room and round. Additive only.
  if (version < 9) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumn(db, 'discussions', 'room_mode', 'TEXT');
      addColumn(db, 'discussions', 'seats', "TEXT NOT NULL DEFAULT '[]'");
      addColumn(db, 'discussions', 'max_rounds', 'INTEGER');
      addColumn(db, 'discussions', 'round', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'discussions', 'room_status', 'TEXT');
      addColumn(db, 'jobs', 'room_id', 'TEXT');
      addColumn(db, 'jobs', 'room_round', 'INTEGER');
      db.exec('PRAGMA user_version = 9');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v10: observations, not quota reservations or predictions of a refill.
  if (version < 10) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS usage_windows (
        route TEXT NOT NULL,
        pool TEXT NOT NULL,
        window TEXT NOT NULL,
        remaining_percent REAL NULL,
        resets_at TEXT NULL,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY(route,pool,window)
      )`);
      db.exec('PRAGMA user_version = 10');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v11 (operator-set parallelism): a per-route override of jobs running at once, and a one-row service settings table
  // with the global override. NULL means the default applies. Additive only.
  if (version < 11) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumn(db, 'platform_state', 'max_running', 'INTEGER');
      db.exec('CREATE TABLE IF NOT EXISTS service_settings(id INTEGER PRIMARY KEY CHECK(id=1), global_max_running INTEGER NULL)');
      db.exec('INSERT OR IGNORE INTO service_settings(id, global_max_running) VALUES(1, NULL)');
      db.exec('PRAGMA user_version = 11');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v12: metadata inventory, with explicit operator ownership and conservative retirement.
  if (version < 12) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS route_models (
        route TEXT NOT NULL,
        model TEXT NOT NULL,
        family TEXT NULL,
        efforts TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL CHECK(state IN ('discovered','verified','validated','preferred','retired')),
        source TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        notes TEXT NULL,
        miss_count INTEGER NOT NULL DEFAULT 0,
        operator_state INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(route,model)
      );
      CREATE TABLE IF NOT EXISTS model_discovery_state (
        route TEXT PRIMARY KEY,
        last_attempt_at TEXT NOT NULL,
        error TEXT NULL
      )`);
      db.exec('PRAGMA user_version = 12');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v13: consumption evidence and an atomic per-job deduplication record. Comparisons are retained so
  // adapters can require corroborating consumption in the same run, rather than infer co-occurrence.
  if (version < 13) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS pool_evidence (
        route TEXT NOT NULL,
        family TEXT NOT NULL,
        pool TEXT NOT NULL,
        window TEXT NOT NULL,
        runs INTEGER NOT NULL,
        consumed_runs INTEGER NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_job_id TEXT NOT NULL,
        PRIMARY KEY(route,family,pool,window)
      );
      CREATE TABLE IF NOT EXISTS pool_evidence_jobs (
        route TEXT NOT NULL,
        job_id TEXT NOT NULL,
        family TEXT NOT NULL,
        observations TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(route,job_id)
      )`);
      db.exec('PRAGMA user_version = 13');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v14: profile rows follow maintained seeds unless explicitly pinned by the operator.
  if (version < 14) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumn(db, 'platform_profiles', 'tracks_latest', 'INTEGER NOT NULL DEFAULT 1');
      db.exec('PRAGMA user_version = 14');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v15: keep operator intent separate from the last successfully probed selection.
  if (version < 15) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const column of ['bin_path', 'bin_selected_path', 'bin_version', 'bin_source', 'bin_installed', 'bin_upstream'])
        addColumn(db, 'platform_state', column, 'TEXT NULL');
      db.exec('PRAGMA user_version = 15');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  if (version < 16) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumn(db, 'platform_state', 'auto_update', 'INTEGER NOT NULL DEFAULT 0');
      for (const column of ['last_update_at', 'last_update_result', 'last_update_version'])
        addColumn(db, 'platform_state', column, 'TEXT NULL');
      db.exec(`CREATE TABLE IF NOT EXISTS cli_update_events (
        route TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        target_version TEXT NOT NULL,
        version TEXT NOT NULL,
        result TEXT NOT NULL,
        log_path TEXT NOT NULL,
        PRIMARY KEY(route, started_at)
      )`);
      db.exec('PRAGMA user_version = 16');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  if (version < 17) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumn(db, 'platform_state', 'sdk_auto_update', 'INTEGER NOT NULL DEFAULT 0');
      for (const column of ['sdk_version', 'sdk_latest', 'sdk_last_update_at', 'sdk_last_update_result', 'sdk_last_update_version'])
        addColumn(db, 'platform_state', column, 'TEXT NULL');
      // The shared maintenance gate in claimQueuedJob keeps claims out during an SDK swap; queued jobs wait.
      // (No triggers across tables: they make later table migrations fragile.)
      db.exec(`DROP TRIGGER IF EXISTS jobs_no_insert_during_sdk_update; DROP TRIGGER IF EXISTS jobs_no_requeue_during_sdk_update;
        PRAGMA user_version = 17;
      `);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  if (version < 18) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          entity_id UNINDEXED, handle UNINDEXED, project_id UNINDEXED, task_id UNINDEXED,
          kind UNINDEXED, primary_text, secondary_text, refs_text
        );
        CREATE TABLE IF NOT EXISTS entity_refs(
          project_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
          handle TEXT NOT NULL, seq INTEGER NOT NULL, ref_token TEXT NOT NULL,
          PRIMARY KEY(project_id, kind, entity_id, ref_token)
        );
        CREATE INDEX IF NOT EXISTS idx_entity_refs_lookup ON entity_refs(project_id, ref_token);
      `);
      backfillMemoryIndex(db);
      db.exec('PRAGMA user_version = 18');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  if (version < 19) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS job_outcomes(
          id INTEGER PRIMARY KEY,
          job_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('applied','verify_pass','verify_fail','accepted','rejected','redone','consult_verdict')),
          detail TEXT NULL,
          actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS job_outcomes_job ON job_outcomes(job_id, kind, id);
        CREATE UNIQUE INDEX IF NOT EXISTS job_outcomes_consult ON job_outcomes(job_id) WHERE kind='consult_verdict';
        PRAGMA user_version = 19;
      `);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v20 (automatic repair, j16 sections 3 and 5): a repair job names its root job. The unique index allows at most one
  // automatic repair per root, even if two terminal updates race. Additive only.
  if (version < 20) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumn(db, 'jobs', 'repair_of', 'TEXT');
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_repair_of ON jobs(repair_of) WHERE repair_of IS NOT NULL;
        PRAGMA user_version = 20;`);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  // v21: consult verdicts recorded on jobs before schema 19 become consult_verdict outcomes, as recordConsultOutcome
  // records them now (completed jobs only; one per job). The backfill actor marks their provenance. Data only.
  if (version < 21) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`INSERT INTO job_outcomes(job_id,kind,detail,actor_id,created_at)
          SELECT j.id,'consult_verdict',j.consult_verdict,'agent-commons:backfill-v21',COALESCE(j.finished_at,j.created_at)
          FROM jobs j WHERE j.status='completed' AND j.consult_verdict IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM job_outcomes o WHERE o.job_id=j.id AND o.kind='consult_verdict')
          ORDER BY j.seq`);
      db.exec('PRAGMA user_version = 21');
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  if (version < 22) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumn(db, 'usage_windows', 'early_reset_observed_at', 'TEXT');
      addColumn(db, 'usage_windows', 'early_reset_scheduled_at', 'TEXT');
      addColumn(db, 'usage_windows', 'early_reset_remaining_percent', 'REAL');
      addColumn(db, 'platform_state', 'cooldown_started_at', 'TEXT');
      addColumn(db, 'platform_state', 'cooldown_quota_windows', 'TEXT');
      addColumn(db, 'platform_state', 'usage_blocked_identity', 'TEXT');
      db.exec(`UPDATE platform_state SET cooldown_started_at=updated_at,
          cooldown_quota_windows=(SELECT json_group_array(json_array(pool,window))
            FROM usage_windows WHERE route=platform_state.adapter_id AND source LIKE 'reply%'
              AND (remaining_percent=0 OR source LIKE '%:closed') AND resets_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          WHERE cooldown_until IS NOT NULL AND cooldown_started_at IS NULL;
        PRAGMA user_version = 22;`);
      db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  if (version < 23) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addColumn(db, 'projects', 'approved_root', 'TEXT');
      addColumn(db, 'projects', 'approved_git_dir', 'TEXT');
      db.exec('PRAGMA user_version = 23; COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
}

/** Adds a column only when it is missing, so a step is safe to run again. */
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  if (!(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

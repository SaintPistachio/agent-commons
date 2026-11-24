// Read-only room viewer: room-report snapshots and the loopback `view` pages read the database without changing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Actor } from './fixtures/service.ts';
import { adapter } from '../src/adapters/registry.ts';
import { listRooms, loadRoom, loadStatus, openViewerDb, renderRoom, renderStatus, roomReport, startViewer, statusReport } from '../src/viewer.ts';

function fixture(t: any) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-viewer-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'); fs.mkdirSync(repo);
  const store = new Store(home);
  // Viewer handles close before the folder is removed (Windows keeps open SQLite files locked).
  const closers: Array<() => unknown> = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); try { store.close(); } catch {} fs.rmSync(base, { recursive: true, force: true }); });
  const claude: Actor = store.createActor('claude-desktop', 'participant', 'claude-desktop').actor;
  for (const id of ['claude', 'codex', 'antigravity']) store.recordProbe(adapter(id)!.capabilities, { state: 'verified' });
  const call = (method: string, input: Record<string, unknown> = {}) => store.call(claude, method, input);
  call('project_create', { name: 'Repo', root: repo, operation_id: randomUUID() });
  const tx = (packet: string) => call('air_tx', { project_id: 'p1', packet, operation_id: randomUUID() });
  const brief = tx('@air1\n#0 art name=brief.md kind=research "Brief: compare <b>ideas</b>"').handles['0'] as string;
  const g = tx(`@air1\n#0 ropen subj="Pick <script>alert(1)</script> ideas" seats=codex:high:critic,ag:high:ops mode=directed max_r=2 "Which ideas should we adopt?"`).handles['0'] as string;
  const jobs = /\(([^)]*)\)/.exec(tx(`@air1\n#0 rstep g=${g} ctx=art:${brief} "first pass"`).handles['0'])![1].split(/[,;]/);
  const finish = (job: string, verdict: string) => store.updateJob(store.jobByRef(job).id, { status: 'completed', finished_at: new Date().toISOString(),
    result: `Adopt the git hardening.\n@air1\n#0 chk verdict=${verdict} p=.8 "${verdict} from this seat"` });
  finish(jobs[0], 'ok'); finish(jobs[1], 'chg');
  return { store, home, g, jobs, brief, closers };
}

test('loadRoom gathers seats, rounds, jobs, posts and context artifacts', t => {
  const f = fixture(t);
  const db = openViewerDb(f.home);
  f.closers.push(() => db.close());
  const room = loadRoom(db, f.g)!;
  assert.equal(room.handle, f.g);
  assert.deepEqual(room.seats.map(s => s.seat), ['critic', 'ops']);
  assert.deepEqual(room.jobs.map(j => [j.handle, j.round, j.seat, j.route, j.verdict]), [[f.jobs[0], 1, 'critic', 'codex', 'ok'], [f.jobs[1], 1, 'ops', 'antigravity', 'chg']]);
  assert.deepEqual(room.messages.map(m => [m.sender, m.evidence]), [['seat:critic', [f.jobs[0]]], ['seat:ops', [f.jobs[1]]]]);
  assert.equal(room.jobs[0].message, room.messages[0].handle, 'each job links to the post it produced');
  assert.ok(room.artifacts.some(a => a.handle === f.brief && a.used_by.length === 2), 'the brief is listed with both seats that read it');
  assert.equal(loadRoom(db, 'g999'), null);
  assert.deepEqual(listRooms(db).map(r => [r.handle, r.jobs, r.messages]), [[f.g, 2, 2]]);
});

test('rendered pages escape stored text and the snapshot embeds artifact content', t => {
  const f = fixture(t);
  const db = openViewerDb(f.home);
  f.closers.push(() => db.close());
  const html = renderRoom(loadRoom(db, f.g)!, { mode: 'live' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /Pick &lt;script&gt;alert\(1\)&lt;\/script&gt; ideas/);
  const snapshot = roomReport(f.home, f.g);
  assert.match(snapshot, /Brief: compare &lt;b&gt;ideas&lt;\/b&gt;/, 'artifact text is embedded, escaped');
  assert.match(snapshot, new RegExp(`id="${f.jobs[1]}"`));
  assert.throws(() => roomReport(f.home, 'g999'), /no room/);
});

function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.end();
  });
}

test('the live viewer needs its start key, checks Host, serves only GET, and never writes', async t => {
  const f = fixture(t);
  const before = (f.store.db.prepare('SELECT count(*) n FROM events').get() as any).n;
  const viewer = await startViewer(f.home, 0);
  f.closers.push(() => viewer.close());
  const origin = new URL(viewer.url).origin;
  assert.equal((await get(origin + '/')).status, 401, 'no key, no page');
  assert.equal((await get(origin + '/?k=' + 'x'.repeat(viewer.token.length))).status, 401);
  const entry = await get(viewer.url);
  assert.equal(entry.status, 303);
  const cookie = String(entry.headers['set-cookie']).split(';')[0];
  assert.match(String(entry.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  const list = await get(origin + '/', { cookie });
  assert.equal(list.status, 200);
  assert.match(list.headers['content-security-policy'] as string, /default-src 'none'/);
  assert.match(list.body, new RegExp(`href="/g/${f.g.slice(1)}"`));
  const room = await get(origin + '/g/' + f.g.slice(1), { cookie });
  assert.equal(room.status, 200);
  assert.match(room.body, /Seats by round/);
  assert.equal((await get(origin + '/a/' + f.brief.slice(1), { cookie })).status, 200);
  assert.equal((await get(origin + '/g/999', { cookie })).status, 404);
  assert.equal((await get(origin + '/', { cookie, host: 'evil.example' })).status, 421, 'DNS rebinding is refused');
  assert.equal((await get(origin + '/', { cookie }, 'POST')).status, 405);
  assert.equal((f.store.db.prepare('SELECT count(*) n FROM events').get() as any).n, before, 'viewing adds nothing to the database');
});

test('status view renders pace rings, 7-day cycle charts, banked resets, and escapes untrusted errors with zero JS', async t => {
  const f = fixture(t);
  const nowMs = Date.now();
  const resetIso = new Date(nowMs + 4 * 86_400_000).toISOString();
  const p1 = new Date(nowMs - 2 * 86_400_000).toISOString();
  const p2 = new Date(nowMs - 60_000).toISOString();
  f.store.recordUsageMeta('codex', {
    accountScope: 'scope-1',
    meta: {
      resetCredits: {
        availableCount: 1,
        capturedAt: p2,
        credits: [{ id: 'rc-1', status: 'available', grantedAt: p1, expiresAt: new Date(nowMs + 36 * 3600_000).toISOString() }],
      },
    },
  });
  f.store.recordUsage('codex', [{ pool: 'codex', window: '10080m', remaining_percent: 82, resets_at: resetIso, observed_at: p1 }], 'app-server');
  f.store.recordUsage('codex', [{ pool: 'codex', window: '10080m', remaining_percent: 64, resets_at: resetIso, observed_at: p2 }], 'app-server');
  f.store.recordUsageError('claude', { kind: 'signedOut<script>alert(1)</script>', method: 'usage', at: p2 });

  const db = openViewerDb(f.home);
  f.closers.push(() => db.close());
  const status = loadStatus(db, f.home, nowMs);
  assert.equal(status.cycles.length, 1);
  assert.equal(status.cycles[0].points.length, 2);

  const html = renderStatus(status, { mode: 'live' });
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<svg[^>]*viewBox="0 0 64 64"/);
  assert.match(html, /<svg class="chart-svg"/);
  assert.match(html, /banked reset/);
  assert.match(html, /href="\/status"/);

  const snap = statusReport(f.home, new Date(nowMs).toISOString());
  assert.match(snap, /Status and quota/);
  assert.ok(!snap.includes('<script>'));

  const viewer = await startViewer(f.home, 0);
  f.closers.push(() => viewer.close());
  const origin = new URL(viewer.url).origin;
  assert.equal((await get(origin + '/status')).status, 401);
  const entry = await get(viewer.url);
  const cookie = String(entry.headers['set-cookie']).split(';')[0];
  const res = await get(origin + '/status', { cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-security-policy'] as string, /default-src 'none'/);
  assert.match(res.body, /Routes and quota pace/);
  assert.equal((await get(origin + '/status', { cookie, host: 'evil.example' })).status, 421);
});

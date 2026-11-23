import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { antigravity } from '../src/adapters/antigravity.ts';
import { acceptedAntigravityIdentity, antigravityInventoryLines, currentAntigravityProfiles } from '../src/adapters/antigravity-inventory.ts';
import type { ProbeContext, UsageWindow } from '../src/adapters/types.ts';

const argon = 'Gemini 4 Argon';
const gemini = 'Gemini Models';
const AG_MISSING = [
  'gemini-4-argon-low',
  'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-high',
  'gemini-4-neon-medium', 'gemini-4-neon-high', 'gemini-4-neon-xhigh',
];

function fixture(t: { after(fn: () => void): void }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-ag-inventory-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'helpers', 'antigravity');
  fs.mkdirSync(state, { recursive: true });
  const approval = { status: 'passed', cli_sha256: '1'.repeat(64), agent_sha256: '2'.repeat(64),
    implementation: { 'routing-seed.json': '3'.repeat(64) } };
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(state, name), JSON.stringify(value));
  write('acceptance.json', approval);
  const helper = path.join(state, 'helper.cjs');
  fs.writeFileSync(helper, `
    const {readFileSync} = require('node:fs');
    const {join} = require('node:path');
    if (process.argv.slice(2).join(' ') !== '-Action Catalog') process.exit(3);
    process.stdout.write(readFileSync(join(process.env.AC_ANTIGRAVITY_STATE, 'reply.json')));
  `);
  const ctx: ProbeContext = { home, options: { antigravity: { file: process.execPath, prefix: [helper] } }, overrides: {} };
  const seed = JSON.parse(fs.readFileSync(new URL('../helpers/antigravity/routing-seed.json', import.meta.url), 'utf8'));
  const promoted = { ...seed.profiles.find((profile: { model: string }) => profile.model === 'gemini-4-hydrogen-high'),
    model: 'gemini-4-hydrogen-xhigh', effort: 'xhigh', tasks: ['coding'], state: 'validated',
    validation: { status: 'passed', identity_hash: acceptedAntigravityIdentity(approval) } };
  const profiles = [...seed.profiles, promoted];
  const variants: Record<string, { family: string; effort: string }> = Object.fromEntries(profiles.map(profile =>
    [profile.model, { family: profile.family, effort: profile.effort }]));
  variants['gemini-3.8-flash-high'] = { family: 'gemini-3.8-flash', effort: 'high' };
  variants['gpt-oss-120b-medium'] = { family: 'gpt-oss-120b', effort: 'medium' };
  const models = Object.fromEntries(Object.keys(variants).map(model => [model, model]));
  const reply = { status: 'SUCCESS', activated: true, quota: [], catalog: { schema_version: 1,
    cli_sha256: approval.cli_sha256, fetched_at: new Date().toISOString(), models, variants,
    unsupported: [{ id: 'gemini-pro-orchestrator-neon', reason: 'Unsupported or missing effort suffix.' }] },
  assignments: { schema_version: 1, profiles } };
  write('reply.json', reply);
  return { home, ctx, reply, approval, write, promoted };
}

test('guarded Antigravity catalog restores exact efforts, exposes qualification and checks quota per pool', async t => {
  const f = fixture(t);
  const rows = await antigravity.discover!(f.ctx);
  for (const model of AG_MISSING) {
    const row = rows.find(row => row.model === model);
    assert.equal(row?.state, 'validated', model);
    assert.deepEqual(row.efforts, [model.split('-').at(-1)]);
  }
  assert.equal(rows.find(row => row.model === 'gemini-3.8-flash-high')?.state, 'discovered');
  assert.equal(antigravity.effectiveEffort?.('coding', 'xhigh', f.home), 'xhigh');
  assert.ok(currentAntigravityProfiles(f.home)?.some(profile => profile.model === f.promoted.model));

  const usage: UsageWindow[] = [{
    route: 'antigravity', source: 'fixture', observed_at: new Date().toISOString(), stale: false,
    pool: argon, window: 'Gemini 4 Argon Weekly Limit', remaining_percent: 0, resets_at: null,
  }];
  f.write('candidate-attempts.json', { attempts: {
    attempt: { model: 'gemini-3.8-flash-high', status: 'failed', reason: 'CANDIDATE_GUARD_FAILED',
      identity_hash: acceptedAntigravityIdentity(f.approval), completed_at: new Date().toISOString() },
  } });
  const lines = antigravityInventoryLines(f.home, usage).join('\n');
  assert.match(lines, /gemini-4-argon-low; effort low; qualified; tasks explain; helper tasks followup; Gemini 4 Argon quota exhausted/);
  assert.match(lines, /gemini-4-hydrogen-xhigh; effort xhigh; qualified; tasks coding; Gemini Models quota unknown/);
  assert.match(lines, /gemini-3.8-flash-high; effort high; awaiting qualification \(last attempt: CANDIDATE_GUARD_FAILED\)/);
  assert.match(lines, /gpt-oss-120b-medium.+unavailable/);
  assert.match(lines, /gemini-pro-orchestrator-neon; unavailable/);
  assert.match(lines, /gemini-4-hydrogen-low.+unavailable for Agent Commons job tasks; helper tasks transform, followup/);
  usage.push({ ...usage[0], pool: gemini, window: 'Weekly Limit Remaining', remaining_percent: 90 });
  // Only one of the two required Gemini quota windows is known.
  assert.match(antigravityInventoryLines(f.home, usage).join('\n'), /gemini-4-hydrogen-xhigh.+Gemini Models quota unknown/);
  usage.push({ ...usage.at(-1)!, window: 'Five Hour Limit Remaining' });
  assert.match(antigravityInventoryLines(f.home, usage).join('\n'), /gemini-4-hydrogen-xhigh.+Gemini Models quota open/);
});

test('partial catalog or stale qualification cannot replace the last good result', async t => {
  const f = fixture(t);
  await antigravity.discover!(f.ctx);
  const before = antigravityInventoryLines(f.home, []);
  f.write('reply.json', { ...f.reply, catalog: { ...f.reply.catalog, models: {} } });
  await assert.rejects(() => antigravity.discover!(f.ctx), /incomplete/);
  assert.deepEqual(antigravityInventoryLines(f.home, []), before);

  f.write('acceptance.json', { ...f.approval, agent_sha256: '4'.repeat(64) });
  assert.equal(currentAntigravityProfiles(f.home), undefined);
  assert.match(antigravityInventoryLines(f.home, [])[0], /stale/);
  f.write('reply.json', f.reply);
  await assert.rejects(() => antigravity.discover!(f.ctx), /invalid assignment/);
});

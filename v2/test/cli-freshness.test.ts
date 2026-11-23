import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cliFreshnessLines, compareCliVersions, launchSelectedCli, parseCliVersion, parseRegistryTags,
  type CliRoute } from '../src/adapters/cli-freshness.ts';
import { codex, resolveCodex } from '../src/adapters/codex.ts';
import type { Active, CliBinary, RunContext } from '../src/adapters/types.ts';
import { Prober } from '../src/prober.ts';
import { Store, type Json } from '../src/store.ts';

const desktop: CliBinary = { path: '/desktop/codex', source: 'desktop install', version: '0.164.0' };
const cache: CliBinary = { path: '/cache/codex', source: 'desktop cache', version: '0.167.0-alpha.4.1' };
const app: CliBinary = { path: '/app/codex', source: 'app package', version: '0.171.0-alpha.13' };
const installed = [cache, desktop, app];

test('parse CLI versions and rank releases and numeric prerelease identifiers', () => {
  assert.equal(parseCliVersion('codex-cli 0.171.0-alpha.13\r\n'), app.version);
  assert.equal(parseCliVersion('2.1.311 (Claude Code)\n'), '2.1.311');
  assert.equal(parseCliVersion('cli v1.2.3+build.1'), '1.2.3+build.1');
  assert.equal(parseCliVersion('codex-cli 0.171.0-alpha.013'), null);
  assert.equal(parseCliVersion('no version'), null);
  assert.ok(compareCliVersions(app.version, '0.171.0') < 0);
  assert.ok(compareCliVersions(app.version, cache.version) > 0);
  assert.ok(compareCliVersions(desktop.version, app.version) < 0);
  assert.ok(compareCliVersions('1.2.3-alpha.13', '1.2.3-alpha.4.1') > 0);
  assert.ok(compareCliVersions('1.2.3-alpha.4', '1.2.3-alpha.4.1') < 0);
  assert.ok(compareCliVersions('1.2.3-4', '1.2.3-beta') < 0);
  assert.equal(compareCliVersions('1.2.3+build.1', '1.2.3+build.2'), 0);
});

test('resolver prefers the newest stable copy; prereleases only when no stable copy passes', async () => {
  const run = async (failing: CliBinary[]) => {
    const checked: string[] = [];
    const result = await resolveCodex({ home: '', options: {}, overrides: {
      binaries: async () => installed,
      cliProbe: async (_route, binary) => {
        checked.push(binary.path);
        return failing.includes(binary) ? { state: 'blocked', reason: 'missing flags: --ephemeral' } : { state: 'verified' };
      },
    } });
    return { checked, result };
  };
  // A stable 0.164.0 beats a newer prerelease (user preference: stable CLI versions).
  let { checked, result } = await run([]);
  assert.deepEqual(checked, [desktop.path]);
  assert.deepEqual(result.binary, desktop);
  // With the stable copy failing, the newest prerelease that passes is used, skipping a failed one.
  ({ checked, result } = await run([desktop, app]));
  assert.deepEqual(checked, [desktop.path, app.path, cache.path]);
  assert.deepEqual(result.binary, cache);
});

test('pin persists, wins, and clears; a failing pin does not fall back', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-cli-pin-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new Store(home);
  try {
    let blocked: string | undefined;
    const prober = new Prober(store, home, {}, {
      binaries: async () => installed,
      upstream: async () => ({ latest: '0.171.0', source: 'fixture' }),
      cliProbe: async (_route, binary) => binary.path === blocked ? { state: 'blocked' } : { state: 'verified' },
    });
    store.setRouteBin(codex.capabilities, desktop.path);
    await prober.probe('codex');
    let state = store.platformState('codex')!;
    assert.equal(state.bin_path, desktop.path);
    assert.equal(state.bin_selected_path, desktop.path);
    assert.equal(state.bin_version, desktop.version);
    assert.equal(state.bin_source, desktop.source);

    blocked = desktop.path;
    await prober.probe('codex');
    state = store.platformState('codex')!;
    assert.equal(state.probe_state, 'blocked');
    assert.equal(state.bin_selected_path, null);

    store.setRouteBin(codex.capabilities, null);
    store.recordProbe(codex.capabilities, { state: 'verified', binary: desktop },
      { pin: desktop.path, installed, upstream: null });
    assert.equal(store.platformState('codex')!.bin_selected_path, null);
    await prober.probe('codex');
    state = store.platformState('codex')!;
    assert.equal(state.bin_path, null);
    assert.equal(state.bin_selected_path, app.path);
    assert.equal(state.bin_version, app.version);
  } finally { store.close(); }
});

test('registry fixture uses only the requested official dist-tags', () => {
  const codexRegistry = 'https://registry.npmjs.org/@openai/codex';
  const codexDocument = { name: '@openai/codex', 'dist-tags': { latest: '0.171.0', alpha: '0.173.0-alpha.1' } };
  assert.deepEqual(parseRegistryTags(codexDocument, codexRegistry, ['latest']), { latest: '0.171.0', source: codexRegistry });
  const claudeRegistry = 'https://registry.npmjs.org/@anthropic-ai/claude-code';
  const claudeDocument = { name: '@anthropic-ai/claude-code', 'dist-tags': { stable: '2.1.311', latest: '2.1.329' } };
  assert.deepEqual(parseRegistryTags(claudeDocument, claudeRegistry, ['stable', 'latest']),
    { stable: '2.1.311', latest: '2.1.329', source: claudeRegistry });
  assert.deepEqual(parseRegistryTags({ 'dist-tags': { latest: 'not semver' } }, codexRegistry, ['latest']), { source: codexRegistry });
});

test('freshness output groups copies and warns against the route-specific upstream tag', () => {
  const state = { adapter_id: 'codex', bin_version: app.version, bin_source: app.source,
    bin_installed: JSON.stringify([...installed, { ...desktop, path: '/copy-1' }, { ...desktop, path: '/copy-2' }]),
    bin_upstream: JSON.stringify({ latest: '0.171.0', source: 'fixture' }) };
  assert.deepEqual(cliFreshnessLines(state), [
    'codex: using 0.171.0-alpha.13 (app package); installed: 0.164.0 x3, 0.167.0-alpha.4.1, 0.171.0-alpha.13; upstream latest 0.171.0',
    'WARN codex: using 0.171.0-alpha.13, below upstream latest 0.171.0',
  ]);
  // Stable is preferred: an unused newer prerelease is not a warning, an unused newer stable copy is.
  assert.ok(!cliFreshnessLines({ ...state, bin_version: desktop.version, bin_source: desktop.source })
    .some(line => line.includes('newer installed')));
  assert.ok(cliFreshnessLines({ ...state, bin_version: '0.159.2', bin_source: 'old install' })
    .includes('WARN codex: newer installed stable CLI 0.164.0 is not used'));
  const claudeState = { adapter_id: 'claude', bin_version: '2.1.311', bin_source: 'native install',
    bin_installed: '[]', bin_upstream: JSON.stringify({ stable: '2.1.311', latest: '2.1.329', source: 'fixture' }) };
  assert.deepEqual(cliFreshnessLines(claudeState, 'stable'), [
    'claude: using 2.1.311 (native install); installed: none; upstream stable 2.1.311, latest 2.1.329',
  ]);
  assert.ok(cliFreshnessLines({ ...claudeState, bin_version: '2.1.207' }, 'stable')
    .includes('WARN claude: using 2.1.207, below upstream stable 2.1.311'));
});

test('job confirms the selected version and records the path and version before starting the CLI', async () => {
  const binary = { ...app, path: process.execPath, version: process.versions.node };
  const job: Json = { id: 'job', timeout_ms: 15_000, options: { keep: true } };
  const route: CliRoute = { id: 'codex', helpArgs: [], flags: [], override: () => undefined,
    command: file => ({ file }), binaries: async () => [binary] };
  let active: Active | undefined;
  let update: { id: string; fields: Json } | undefined;
  let launched: { file: string; version: string | null; options: Json; update: typeof update } | undefined;
  await new Promise<void>((resolve, reject) => {
    const ctx = { options: {}, store: {
      platformState: () => ({ probe_state: 'verified', bin_selected_path: binary.path, bin_version: binary.version }),
      updateJob: (id: string, fields: Json) => { update = { id, fields }; },
    },
    annotate: (options: Json) => Object.assign(job.options, options),
    track: (value: Active) => { active = value; },
    active: () => active,
    finish: (status: string, fields: Json) => reject(new Error(`${status}: ${fields.error}`)),
    } as unknown as RunContext;
    launchSelectedCli(job, ctx, route, async () => assert.fail('matching version should not require re-selection'), (command, version) => {
      launched = { file: command.file, version, options: { ...job.options }, update };
      resolve();
    });
  });
  assert.deepEqual(launched, {
    file: binary.path, version: binary.version,
    options: { keep: true, cli: { path: binary.path, version: binary.version } },
    update: { id: job.id, fields: { adapter_version: binary.version } },
  });
});

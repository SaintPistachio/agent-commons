import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { defaultOpenAIHelperRoot } from '../src/adapters/openai-models.ts';

test('defaultOpenAIHelperRoot uses the environment, config, sibling, and fallback in order', () => {
  const codexTemp = 'F:\\Temp\\Codex';
  const temp = process.platform === 'win32' && fs.existsSync(codexTemp) ? codexTemp : os.tmpdir();
  const root = fs.mkdtempSync(path.join(temp, 'ac-helper-resolution-'));
  try {
    const home = path.join(root, 'Foo-data');
    const sibling = path.join(root, 'Foo', 'tools', 'openai-capabilities');
    const configured = path.join(root, 'configured');
    const override = path.join(root, 'override');
    const config = path.join(home, 'backup-config.json');
    const run = path.join(sibling, 'run.py');
    fs.mkdirSync(home);
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ openaiHelperRoot: '../configured' }));
    fs.writeFileSync(run, '# Test fixture\n');

    assert.equal(defaultOpenAIHelperRoot(home, { AGENT_COMMONS_OPENAI_HELPER_ROOT: ` ${override} ` }), override);
    assert.equal(defaultOpenAIHelperRoot(home, {}), configured);
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const env = { ...process.env };
    delete env.AGENT_COMMONS_OPENAI_HELPER_ROOT;
    const helperSelection = (environment: NodeJS.ProcessEnv) => JSON.parse(execFileSync(process.execPath,
      ['--disable-warning=ExperimentalWarning', cli, 'helper-root', '--home', home],
      { encoding: 'utf8', cwd: root, env: environment }));
    assert.deepEqual(helperSelection(env), { root: configured, configured: true });
    assert.deepEqual(helperSelection({ ...env, AGENT_COMMONS_OPENAI_HELPER_ROOT: override }), { root: override, configured: true });
    assert.deepEqual(helperSelection({ ...env, AGENT_COMMONS_OPENAI_HELPER_ROOT: '../override' }),
      { root: override, configured: true });
    fs.writeFileSync(config, JSON.stringify({ openaiHelperRoot: '' }));
    assert.throws(() => defaultOpenAIHelperRoot(home, {}), /nonempty path/);

    fs.unlinkSync(config);
    assert.equal(defaultOpenAIHelperRoot(home, {}), sibling);

    fs.unlinkSync(run);
    const checkout = fileURLToPath(new URL('../../tools/openai-capabilities', import.meta.url));
    assert.equal(defaultOpenAIHelperRoot(home, {}),
      fs.existsSync(path.join(checkout, 'run.py')) ? checkout : sibling);
    assert.equal(defaultOpenAIHelperRoot(undefined, {}), checkout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

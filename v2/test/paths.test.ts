import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaultHome } from '../src/paths.ts';

const home = path.resolve('T:/LocalProjects/Personal/AgentCommons-data');

test('an installed release finds its own home; a source checkout gets none (never the user profile)', () => {
  assert.equal(defaultHome(path.join(home, 'app', 'abc123', 'v2', 'src', 'cli.ts'), {}), home);
  assert.equal(defaultHome(path.join(home, 'current', 'v2', 'src', 'cli.ts'), {}), home);
  assert.equal(defaultHome(path.resolve('T:/LocalProjects/Personal/AgentCommons/v2/src/cli.ts'), {}), undefined);
  assert.equal(defaultHome(path.resolve('T:/x/v2/src/cli.ts'), { AGENT_COMMONS_HOME: home }), home);
  // Found by the live antigravity review (job d93a594b): only the exact release layout counts.
  assert.equal(defaultHome(path.join(home, 'app', 'abc123', 'other', 'src', 'cli.ts'), {}), undefined);
  assert.equal(defaultHome(path.join(home, 'app', 'abc123', 'v2', 'src', 'sub', 'cli.ts'), {}), undefined);
});

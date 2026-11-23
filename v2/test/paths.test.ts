import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaultHome } from '../src/paths.ts';

const home = path.resolve('fixtures/agent-commons-data');

test('an installed release finds its own home; a source checkout gets none (never the user profile)', () => {
  assert.equal(defaultHome(path.join(home, 'app', 'abc123', 'v2', 'src', 'cli.ts'), {}), home);
  assert.equal(defaultHome(path.join(home, 'current', 'v2', 'src', 'cli.ts'), {}), home);
  assert.equal(defaultHome(path.resolve('fixtures/agent-commons/v2/src/cli.ts'), {}), undefined);
  assert.equal(defaultHome(path.resolve('fixtures/other/v2/src/cli.ts'), { AGENT_COMMONS_HOME: home }), home);
  // Only the exact installed release layout counts.
  assert.equal(defaultHome(path.join(home, 'app', 'abc123', 'other', 'src', 'cli.ts'), {}), undefined);
  assert.equal(defaultHome(path.join(home, 'app', 'abc123', 'v2', 'src', 'sub', 'cli.ts'), {}), undefined);
});

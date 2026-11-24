import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditHosts, formatHostAudit, parseCodexMcpServers } from '../src/host-audit.ts';

test('parseCodexMcpServers handles quoted keys, comments, multiline args, and subtables', () => {
  const toml = `
[mcp_servers.alpha] # trailing comment
command = "node"
args = [
  "--disable-warning=ExperimentalWarning", # inline comment
  "C:\\\\Projects\\\\app\\\\mcp.ts",
]

[mcp_servers.alpha.env]
NODE_ENV = "production"

[mcp_servers."beta-one"]
enabled = false
url = 'http://127.0.0.1:4727/mcp'

[[plugins]]
command = "should-not-attach-to-beta"

[other_section]
command = "ignored"
`;
  const parsed = parseCodexMcpServers(toml);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    name: 'alpha',
    source: 'config.toml',
    enabled: true,
    command: 'node',
    args: ['--disable-warning=ExperimentalWarning', 'C:\\Projects\\app\\mcp.ts'],
  });
  assert.deepEqual(parsed[1], {
    name: 'beta-one',
    source: 'config.toml',
    enabled: false,
    args: [],
    url: 'http://127.0.0.1:4727/mcp',
  });
  const dotted = parseCodexMcpServers('mcp_servers.gamma.command = "node"\nmcp_servers.gamma.args = ["a.js"]\n');
  assert.deepEqual(dotted, [{ name: 'gamma', source: 'config.toml', enabled: true, command: 'node', args: ['a.js'] }]);
});

test('auditHosts detects duplicates, collisions, missing paths, tool-hub conflicts, and redacts secrets', t => {
  const base = mkdtempSync(join(tmpdir(), 'ac-audit-'));
  const home = join(base, 'ac-home');
  const userHome = join(base, 'user-home');
  mkdirSync(join(home, 'connections'), { recursive: true });
  mkdirSync(join(home, 'skills', 'shared-skill'), { recursive: true });
  mkdirSync(join(userHome, '.codex', 'skills'), { recursive: true });
  mkdirSync(join(userHome, '.claude'), { recursive: true });
  mkdirSync(join(userHome, '.gemini', 'config', 'plugins', 'custom'), { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const validConn = join(home, 'connections', 'codex.json');
  const driftedConn = join(base, 'elsewhere', 'drifted.json');
  mkdirSync(join(base, 'elsewhere'));
  writeFileSync(validConn, '{}');
  writeFileSync(driftedConn, '{}');

  const missingExe = join(base, 'nonexistent', 'node.exe');
  const missingConn = join(home, 'connections', 'missing.json');

  const fakeOpenAiKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
  const fakeGhToken = 'ghp_123456789012345678901234567890123456';
  const fakeAwsKey = 'AKIAIOSFODNN7EXAMPLE';

  // Codex: duplicate enabled servers + missing executable + secret in AGENTS.md
  const codexToml = `
[mcp_servers.ac_one]
command = "node"
args = ["mcp.ts", "--connection", ${JSON.stringify(validConn)}]

[mcp_servers.ac_two]
command = "node"
args = ["mcp.ts", "--connection", ${JSON.stringify(validConn)}]

[mcp_servers.broken]
command = ${JSON.stringify(missingExe)}
args = [${JSON.stringify(`--connection=${missingConn}`)}]
`;
  writeFileSync(join(userHome, '.codex', 'config.toml'), codexToml);
  writeFileSync(join(userHome, '.codex', 'AGENTS.md'), `token=${fakeOpenAiKey}\n`);

  // Claude: drifted connection + GitHub token in settings.json
  writeFileSync(join(userHome, '.claude.json'), JSON.stringify({
    mcpServers: {
      ac: { command: 'node', args: ['mcp.ts', '--connection', driftedConn] },
    },
  }));
  writeFileSync(join(userHome, '.claude', 'settings.json'), JSON.stringify({ env: { GH: fakeGhToken } }));

  // Antigravity: name collision between global and plugin + AWS key in GEMINI.md
  writeFileSync(join(userHome, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      shared: { command: 'node', args: ['a.js'] },
    },
  }));
  writeFileSync(join(userHome, '.gemini', 'config', 'plugins', 'custom', 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      shared: { command: 'node', args: ['b.js'] },
    },
  }));
  writeFileSync(join(userHome, '.gemini', 'GEMINI.md'), `aws=${fakeAwsKey}\n`);

  // Tool-hub conflict: regular file where Codex expects a skill junction
  writeFileSync(join(home, 'skills', 'shared-skill', 'SKILL.md'), '---\ndescription: test\n---\n');
  writeFileSync(join(home, 'tools.json'), JSON.stringify({
    schema: 1,
    skills_root: join(home, 'skills'),
    servers: {},
    clis: {},
    toolsets: {},
  }));
  writeFileSync(join(userHome, '.codex', 'skills', 'shared-skill'), 'not a junction');

  const beforeToml = readFileSync(join(userHome, '.codex', 'config.toml'), 'utf8');
  const report = auditHosts({ home, userHome });
  assert.equal(report.clean, false);

  const kinds = new Set(report.findings.map(f => f.kind));
  assert.ok(kinds.has('duplicate_mcp_server'));
  assert.ok(kinds.has('missing_executable'));
  assert.ok(kinds.has('missing_connection'));
  assert.ok(kinds.has('drifted_connection'));
  assert.ok(kinds.has('mcp_name_collision'));
  assert.ok(kinds.has('tool_hub_conflict'));
  assert.ok(kinds.has('credential_marker'));

  // Secret tokens must NEVER appear in serialized JSON or formatted output
  const jsonText = JSON.stringify(report);
  const formatted = formatHostAudit(report);
  for (const secret of [fakeOpenAiKey, fakeGhToken, fakeAwsKey]) {
    assert.ok(!jsonText.includes(secret), 'JSON report leaked secret');
    assert.ok(!formatted.includes(secret), 'formatted report leaked secret');
  }

  // Host config files were never modified
  assert.equal(readFileSync(join(userHome, '.codex', 'config.toml'), 'utf8'), beforeToml);

  // Oversized file (>2 MiB) emits config_invalid instead of silently passing
  const bigUserHome = join(base, 'big-user-home');
  mkdirSync(join(bigUserHome, '.claude'), { recursive: true });
  writeFileSync(join(bigUserHome, '.claude.json'), ' '.repeat(2 * 1024 * 1024 + 64));
  const bigReport = auditHosts({ home, userHome: bigUserHome, apps: ['claude'] });
  assert.equal(bigReport.clean, false);
  assert.ok(bigReport.findings.some(f => f.kind === 'config_invalid' && f.detail.includes('2 MiB')));
});

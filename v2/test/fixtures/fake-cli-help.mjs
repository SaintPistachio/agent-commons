// Stand-in for a CLI's --version and --help output, for adapter probes. The first argument picks the flavor:
//   claude-ok | claude-missing | codex-ok | broken
const [flavor, ...args] = process.argv.slice(2);
const CLAUDE = ['-p, --print', '--output-format', '--permission-mode', '--tools', '--allowedTools', '--model', '--effort', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '--settings', '--mcp-config', '--disallowedTools', '--add-dir'];
const CODEX = ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', '--cd', '--output-last-message', '--model', '--config', '--add-dir'];
if (flavor === 'broken') process.exit(3);
if (args.includes('--version')) { process.stdout.write(flavor.startsWith('codex') ? 'codex-cli 9.9.9\n' : '9.9.9 (Claude Code)\n'); process.exit(0); }
const flags = flavor === 'codex-ok' ? CODEX : flavor === 'claude-missing' ? CLAUDE.filter(f => f !== '--effort') : CLAUDE;
process.stdout.write('Usage: cli [options]\n' + flags.map(f => `  ${f}  some text`).join('\n') + '\n');

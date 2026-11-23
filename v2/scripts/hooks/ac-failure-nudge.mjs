#!/usr/bin/env node
// PostToolUse hook (shell tool) for Claude Code and Codex (never Antigravity). Counts consecutive failed commands per
// session. At the second failure, and every third after, prints one line suggesting a consult, naming idle peers of
// another model family from Agent Commons (route_hints). A success resets the count; a result without an exit code
// changes nothing. Never blocks: any error prints nothing and exits 0.
//
//   node ac-failure-nudge.mjs [--connection <file>] [--state-dir DIR] [--format plain|json] [--timeout-ms 2000]
//
// The count lives in <state-dir>/ac-hook-fails-<session>.json (default: the system temp folder). Without a connection
// (or with the service down) the line names no peers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };

/** The command's exit code from the hook input, or null when the input does not say. */
function exitCode(response) {
  if (!response || typeof response !== 'object') return null;
  for (const key of ['exit_code', 'exitCode', 'returncode', 'code']) if (Number.isInteger(response[key])) return response[key];
  if (response.is_error === true) return 1;
  return null;
}

async function peers() {
  const file = option('connection', process.env.AGENT_COMMONS_CONNECTION);
  if (!file) return '';
  try {
    const connection = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const response = await fetch(connection.url + '/api/v1/call', {
      method: 'POST', signal: AbortSignal.timeout(Number(option('timeout-ms', '2000'))),
      headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'route_hints', input: {} }),
    });
    const body = await response.json();
    return response.ok && typeof body?.result?.air === 'string' ? body.result.air : '';
  } catch { return ''; }
}

async function main() {
  let input = {};
  try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const code = exitCode(input.tool_response);
  if (code === null) return;
  const session = String(input.session_id ?? 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'default';
  const dir = option('state-dir', process.env.AC_HOOK_STATE_DIR ?? os.tmpdir());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ac-hook-fails-${session}.json`);
  let count = 0;
  try { count = Number(JSON.parse(fs.readFileSync(file, 'utf8')).count) || 0; } catch { /* first command of the session */ }
  count = code === 0 ? 0 : count + 1;
  fs.writeFileSync(file, JSON.stringify({ count, at: new Date().toISOString() }));
  if (!(count === 2 || (count > 2 && (count - 2) % 3 === 0))) return;
  const idle = await peers();
  const text = `AC hint: ${count} consecutive command failures.${idle ? ` Idle peers of another model family: ${idle}.` : ''}`
    + ` Consider air_tx ask wake=auto, or a job with proto=air, with ctx= pointing at the failure before attempt ${count + 1}.`;
  return (option('format', 'plain') === 'json'
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? 'PostToolUse', additionalContext: text } })
    : text) + '\n';
}

// Exit only after the output is written (a pipe may still be flushing), and always with 0.
main().catch(() => undefined).then(out => out ? process.stdout.write(out, () => process.exit(0)) : process.exit(0));

#!/usr/bin/env node
// SessionStart hook for Claude Code and Codex (never Antigravity). Peeks at the Agent Commons project for the session's
// working folder (air_sync with root, advance_cursor false: nothing is marked read) and prints it for the model.
// Never blocks a session: no connection, no service, no matching project, or any error prints nothing and exits 0.
//
//   node ac-session-start.mjs --connection <connection file> [--format plain|json] [--timeout-ms 2000]
//
// --connection may be replaced by AGENT_COMMONS_CONNECTION. --format json prints
// {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}} (the context field both Claude Code
// and Codex hooks accept); plain prints the text. The hook's JSON input on stdin supplies cwd.
import fs from 'node:fs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };

async function main() {
  let input = {};
  try { if (!process.stdin.isTTY) input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no usable input */ }
  const file = option('connection', process.env.AGENT_COMMONS_CONNECTION);
  if (!file) return;
  const connection = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const response = await fetch(connection.url + '/api/v1/call', {
    method: 'POST', signal: AbortSignal.timeout(Number(option('timeout-ms', '2000'))),
    headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'air_sync', input: { root: input.cwd ?? process.cwd(), advance_cursor: false } }),
  });
  const body = await response.json();
  if (!response.ok || typeof body?.result?.air !== 'string') return;
  const text = `Agent Commons (peek; nothing is marked read):\n${body.result.air}`;
  return (option('format', 'plain') === 'json'
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name ?? 'SessionStart', additionalContext: text } })
    : text) + '\n';
}

// Exit only after the output is written (a pipe may still be flushing), and always with 0.
main().catch(() => undefined).then(out => out ? process.stdout.write(out, () => process.exit(0)) : process.exit(0));

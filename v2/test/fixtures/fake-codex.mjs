// Stand-in for `codex exec --json ... -o FILE`: reads the prompt from stdin, prints JSONL events, writes the last message.
import fs from 'node:fs';
import path from 'node:path';
import { patchResponse } from './fake-patch-response.mjs';
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1], cd = args[args.indexOf('-C') + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const event = value => process.stdout.write(JSON.stringify(value) + '\n');
  event({ type: 'thread.started', thread_id: 't1' });
  event({ type: 'turn.started' });
  if (prompt.includes('LIMIT')) { event({ type: 'error', message: "You've hit your usage limit. Try again later." }); event({ type: 'turn.failed', error: { message: 'usage limit' } }); process.exit(1); }
  if (prompt.includes('SLEEP')) { setTimeout(() => {}, 60000); return; }
  const patch = patchResponse(prompt);
  if (patch && (!args.includes('features.shell_tool=false') || !args.includes('read-only') || !cd.includes('ac-patch-worker-')))
    throw new Error('patch worker was not launched read-only with shell tools disabled in external scratch');
  if (!patch && prompt.includes('EDIT')) fs.writeFileSync(path.join(cd, 'codex-edit.txt'), 'changed by codex\n');
  const reply = patch ?? (prompt.includes('ARGS') ? JSON.stringify({ args, cwd: process.cwd(), apiKey: !!process.env.OPENAI_API_KEY || !!process.env.CODEX_API_KEY }) : 'codex: ' + prompt.trim());
  fs.writeFileSync(out, reply);
  event({ type: 'item.completed', item: { type: 'agent_message', text: reply } });
  event({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
});

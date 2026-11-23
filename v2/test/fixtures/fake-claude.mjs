// Stand-in for `claude -p --output-format json`: reads the prompt from stdin and acts on keywords.
import fs from 'node:fs';
import { patchResponse } from './fake-patch-response.mjs';
const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const reply = (result, extra = {}) => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result, ...extra }));
  const patch = patchResponse(prompt);
  if (patch) {
    if (!args.includes('--tools') || args[args.indexOf('--tools') + 1] !== '' || !process.cwd().includes('ac-patch-worker-'))
      throw new Error('patch worker was not launched with native tools disabled in external scratch');
    return reply(patch);
  }
  if (prompt.includes('SLEEP')) { setTimeout(() => reply('woke'), 60000); return; }
  if (prompt.includes('DELAY')) { setTimeout(() => reply('late'), 800); return; }
  // The AIR cases look at the request line only, so the worker primer's own words never trigger them.
  const request = prompt.slice(prompt.lastIndexOf('@request'));
  if (request.includes('AIRBLOCK')) return reply('Looked at it. Two issues.\n\n```\n@air1\n#0 ref file:a.txt:1 status=fail\n#1 chk ok=#0 verdict=chg p=.8 "needs a guard"\n```\n');
  if (request.includes('AIRBAD')) return reply('Answer.\n@air1\n#0 tnew "not allowed for workers"');
  if (prompt.includes('BIGOUT')) return reply('HEAD' + 'x'.repeat(100000) + 'TAIL');
  if (prompt.includes('USAGE')) return reply('counted', { usage: { input_tokens: 120, output_tokens: 34 }, modelUsage: { 'claude-test-model': { inputTokens: 120 } } });
  // Usage limits as the CLI reports them: with a reset time after "|" (epoch seconds), or without one.
  if (prompt.includes('LIMITHIT')) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|' + (Math.floor(Date.now() / 1000) + 3600) })); process.exit(1); }
  if (prompt.includes('LIMIT5H')) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 2:10pm (America/Chicago)" })); process.exit(1); }
  if (prompt.includes('LIMITSOON')) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your usage limit" })); process.exit(1); }
  if (prompt.includes('FAIL')) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' })); process.exit(1); }
  if (prompt.includes('GARBAGE')) { process.stderr.write('fatal: not json'); process.exit(2); }
  if (prompt.includes('EDIT')) { fs.writeFileSync('from-job.txt', 'written by job\n'); return reply('edited'); }
  if (prompt.includes('ENV')) return reply(JSON.stringify({ apiKey: !!process.env.ANTHROPIC_API_KEY, jobId: process.env.AGENT_COMMONS_JOB_ID, cwd: process.cwd(), args }));
  reply('echo: ' + prompt.trim());
});

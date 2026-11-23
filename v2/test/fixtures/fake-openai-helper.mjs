// Stand-in for the central OpenAI helper CLI (run.py): refresh-costs, invoke --request FILE, lookup --external-request-id ID.
// Runs with cwd = a test directory; logs every call to calls.log there and answers lookup from lookup.json.
import fs from 'node:fs';
import { patchResponse } from './fake-patch-response.mjs';
const [command, ...rest] = process.argv.slice(2);
const log = entry => fs.appendFileSync('calls.log', JSON.stringify(entry) + '\n');
const reply = (value, code = 0) => { process.stdout.write(JSON.stringify(value)); process.exit(code); };
if (command === 'refresh-costs') {
  log({ command });
  // A slow-refresh file holds the reply, so a test can stop or break the runner before invoke.
  if (fs.existsSync('slow-refresh')) setTimeout(() => reply({ status: 'ok' }), 1500); else reply({ status: 'ok' });
}
if (command === 'lookup') {
  const id = rest[rest.indexOf('--external-request-id') + 1];
  log({ command, id });
  reply(fs.existsSync('lookup.json') ? JSON.parse(fs.readFileSync('lookup.json', 'utf8')) : { status: 'not_found' }, 2);
}
if (command === 'invoke') {
  const request = JSON.parse(fs.readFileSync(rest[rest.indexOf('--request') + 1], 'utf8'));
  log({ command, request });
  // Tool turns follow tool-script.json: one entry per turn ({ text, calls: [{ name, arguments }], cost, status, sleep }).
  if (request.payload.tools) {
    const script = JSON.parse(fs.readFileSync('tool-script.json', 'utf8'));
    const n = (fs.existsSync('tool-turn') ? Number(fs.readFileSync('tool-turn', 'utf8')) : 0) + 1;
    fs.writeFileSync('tool-turn', String(n));
    const step = script[Math.min(n, script.length) - 1];
    const answer = () => {
      if (step.status === 'blocked') reply({ status: 'blocked', error_code: step.error_code ?? 'job_cap_exceeded' }, 2);
      if (step.status && step.status !== 'completed') reply({ status: step.status, job_id: `hj-t${n}`, ...(step.cost !== undefined ? { cost_usd: step.cost } : {}) }, 2);
      reply({ status: 'completed', job_id: `hj-t${n}`, model: 'gpt-6.2-sol-2026-11',
        output: { text: step.text ?? '', function_calls: (step.calls ?? []).map((c, i) => ({ call_id: `call_${n}_${i}`, name: c.name, arguments: c.arguments })) },
        ...(step.cost === null ? {} : { cost_usd: step.cost ?? '0.010000' }), usage: { input_tokens: 1000 * n, output_tokens: 50 } });
    };
    if (step.sleep) setTimeout(answer, step.sleep); else answer();
  } else {
  const input = request.payload.input;
  if (input.includes('PATCH-UNCERTAIN-FIXTURE')) reply({ status: 'uncertain', job_id: 'hj-uncertain' }, 2);
  const patch = patchResponse(input);
  if (patch) reply({ status: 'completed', job_id: 'hj-' + request.external_request_id.slice(0, 8), output: patch,
    cost_usd: '0.010000125', usage: { input_tokens: 21, output_tokens: 9 } });
  if (input.includes('BLOCK')) reply({ status: 'blocked', error_code: 'grant_expired', next_action: 'refresh funding' }, 2);
  if (input.includes('UNCERTAIN')) reply({ status: 'uncertain', job_id: 'hj-uncertain', next_action: 'inspect' }, 2);
  if (input.includes('FAILED')) reply({ status: 'failed', job_id: 'hj-failed', error_code: 'provider_error', cost_usd: '0.000010' }, 2);
  if (input.includes('SLEEP')) { setTimeout(() => reply({ status: 'completed', job_id: 'hj-late', output: 'late' }), 60000); }
  else reply({ status: 'completed', job_id: 'hj-ok', output: 'api: ' + input, cost_usd: '0.000123', service_tier: request.tier, model: 'gpt-6-luna-2026-11', usage: { input_tokens: 21, output_tokens: 9 } });
}
}

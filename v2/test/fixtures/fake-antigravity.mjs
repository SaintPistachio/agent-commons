// Stand-in for `pwsh -File Invoke-Antigravity.ps1 -Action Run ...`. Runs with cwd = the job folder.
// Writes its arguments to args.json there; the prompt text picks the outcome.
import fs from 'node:fs';
import { patchResponse } from './fake-patch-response.mjs';
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
fs.writeFileSync('args.json', JSON.stringify(args));
fs.writeFileSync('env.json', JSON.stringify({ AC_ANTIGRAVITY_STATE: process.env.AC_ANTIGRAVITY_STATE ?? null }));
const prompt = fs.readFileSync(value('-PromptPath'), 'utf8');
const reply = (body, code = 2) => { process.stderr.write('[antigravity-helper] progress\n'); process.stdout.write(JSON.stringify(body) + '\n'); process.exit(code); };
const run = { run_id: 'run-1', process_id: 4242 };
const quotas = (gemini = 1, claude = 97, argon = 94) => {
  const weekly = new Date(Date.now() + 3 * 86400000).toISOString();
  const hourly = new Date(Date.now() + 2 * 3600000).toISOString();
  return [
    { group: 'Gemini Models', limit: 'Weekly Limit Remaining', remaining_percent: gemini, resets_at: weekly },
    { group: 'Gemini Models', limit: 'Five Hour Limit Remaining', remaining_percent: 100, resets_at: hourly },
    { group: 'Claude and GPT models', limit: 'Weekly Limit Remaining', remaining_percent: claude, resets_at: weekly },
    { group: 'Claude and GPT models', limit: 'Five Hour Limit Remaining', remaining_percent: 100, resets_at: hourly },
    { group: 'Gemini 4 Argon', limit: 'Gemini 4 Argon Weekly Limit', remaining_percent: argon, resets_at: weekly },
  ];
};
if (prompt.includes('POOL_QUOTA')) reply({ status: 'BLOCKED', error_code: 'QUOTA_EXHAUSTED', error: 'Gemini weekly limit',
  ...run, submission_state: 'not_submitted', prompt_submitted: false, terminal_received: false,
  quota_before: quotas(1), quota_after: quotas(0) });
if (prompt.includes('ALL_QUOTA')) reply({ status: 'BLOCKED', error_code: 'QUOTA_EXHAUSTED', error: 'Gemini weekly limit',
  ...run, submission_state: 'not_submitted', prompt_submitted: false, terminal_received: false, quota_after: quotas(0, 0, 0) });
if (prompt.includes('QUOTA')) reply({ status: 'BLOCKED', error_code: 'QUOTA_EXHAUSTED', error: 'Gemini weekly limit', ...run, submission_state: 'not_submitted', prompt_submitted: false, terminal_received: false });
if (prompt.includes('NO_MODEL_UNKNOWN')) reply({ status: 'BLOCKED', error_code: 'NO_ELIGIBLE_MODEL' });
if (prompt.includes('NO_MODEL_SUBMITTED')) reply({ status: 'BLOCKED', error_code: 'NO_ELIGIBLE_MODEL',
  ...run, prompt_submitted: false, submission_state: 'submitted' });
if (prompt.includes('NO_MODEL')) reply({ status: 'BLOCKED', error_code: 'NO_ELIGIBLE_MODEL',
  prompt_submitted: false, submission_state: 'not_submitted',
  error: 'No sufficiently capable advertised model has the requested validated effort and verified remaining quota.' });
if (prompt.includes('AG_USAGE')) reply({ status: 'SUCCESS', response: 'observed', ...run,
  reported_model: 'claude-opus-5-5-high', selected_model: 'claude-opus-5-5-high',
  prompt_submitted: true, submission_state: 'submitted', terminal_received: true,
  quota_before: quotas(20, 98), quota_after: quotas() }, 0);
if (prompt.includes('BEFORE_USAGE')) reply({ status: 'SUCCESS', response: 'observed before', ...run,
  selected_model: 'gpt-example-high', prompt_submitted: true, terminal_received: true, quota_before: quotas() }, 0);
if (prompt.includes('AMBIENT')) reply({ status: 'BLOCKED', error_code: 'AMBIENT_CUSTOMIZATIONS', error: 'Ambient Antigravity rules or skills require review.' });
if (prompt.includes('PREFLIGHT')) reply({ status: 'BLOCKED', error_code: 'REVALIDATION_REQUIRED', error: 'Probe required' });
if (prompt.includes('UNCLEAR')) reply({ status: 'BLOCKED', error_code: 'INFERENCE_TIMEOUT', ...run, submission_state: 'submitted', prompt_submitted: true, terminal_received: false });
if (prompt.includes('INVALID')) reply({ status: 'INVALID_OUTPUT', ...run, submission_state: 'submitted', prompt_submitted: true, terminal_received: true });
// The helper's catch-all prints no run fields even after a submitted run (for example output validation).
if (prompt.includes('LATE_ERROR')) reply({ status: 'BLOCKED', error_code: 'LOCAL_ERROR', error: 'ValueError' });
if (prompt.includes('CONTRADICTION')) reply({ status: 'BLOCKED', error_code: 'INFERENCE_TIMEOUT', ...run, submission_state: 'not_submitted', prompt_submitted: true });
if (prompt.includes('TWO_LINES')) { process.stdout.write(JSON.stringify({ status: 'BLOCKED', error_code: 'REVALIDATION_REQUIRED' }) + '\n'); reply({ status: 'BLOCKED', error_code: 'INFERENCE_TIMEOUT' }); }
if (prompt.includes('SLEEP')) setTimeout(() => reply({ status: 'SUCCESS', response: 'late' }, 0), 60000);
else reply({ status: 'SUCCESS', response: patchResponse(prompt) ?? ('ag: ' + prompt), reported_model: 'gemini-4-argon-high', usage: { input_tokens: 11, output_tokens: 7 }, ...run, submission_state: 'submitted', terminal_received: true }, 0);

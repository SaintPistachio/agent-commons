import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  completeProjectModels, documentedModel, openAIPublicModelLines, publicInventorySummary, publicModelIds, refreshPublicInventory,
} from '../src/adapters/openai-public-inventory.ts';

const publicModels = [
  'gpt-audio-1.5', 'gpt-live-1.1', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-realtime-translate',
  'gpt-live-transcribe', 'gpt-realtime-whisper', 'gpt-transcribe', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst',
  'text-embedding-3-small', 'text-embedding-3-large', 'omni-moderation-latest',
];
const docModels = ['gpt-6.2-sol', ...publicModels];
const restricted = ['gpt-6-cyber', 'gpt-6-rosalind', 'gpt-6.2-astra-law'];
const obsolete = ['gpt-realtime-2', 'gpt-image-2.5-sunburst', 'text-embedding-ada-002', 'gpt-4o-mini-tts'];
const index = ['# All models', '## Flagship models', ...[...docModels, ...restricted, ...obsolete]
  .map(model => '- [Model](/api/docs/models/' + model + '.md): ' + (model.endsWith('ada-002') ? 'Older embedding model' : 'Model'))].join('\n');
const deprecated = '## Upcoming deprecations\n| **Jan 6, 2027** | \x60gpt-4o-mini-tts\x60 | Deprecated | \x60gpt-realtime-2.1-mini\x60 | date |\n';
const rt = 'Constrains effort on reasoning for reasoning-capable Realtime models such as\n    \x60gpt-realtime-2\x60.\n\n' +
  ['minimal', 'low', 'medium', 'high', 'xhigh'].map(level => '    - \x60"' + level + '"\x60\n').join('') +
  '    - \x60ToolChoiceOptions = "none" or "auto"\x60';
const quality = 'For the Sunburst and Flare models in both GPT-Image-2.6 and GPT-Image-2.5, the quality options are ' +
  '\x60low\x60, \x60medium\x60,\n\x60high\x60, \x60xhigh\x60, and \x60max\x60.';
const reasoning = 'GPT-6.2 Astra, GPT-6.2 Sol, GPT-6.1 Terra, and GPT-6 Luna support \x60low\x60,\n' +
  '\x60medium\x60, \x60high\x60, \x60xhigh\x60, and \x60max\x60.';

function routes(model: string): string[] {
  if (model.startsWith('gpt-image')) return ['v1/images/generations', 'v1/images/edits'];
  if (model === 'gpt-live-1.1') return ['v1/live/sessions'];
  if (model.endsWith('translate')) return ['v1/realtime/translations'];
  if (model === 'gpt-transcribe') return ['v1/audio/transcriptions', 'v1/realtime/transcription_sessions'];
  if (model.endsWith('whisper') || model.endsWith('transcribe')) return ['v1/realtime/transcription_sessions'];
  if (model.startsWith('gpt-realtime')) return ['v1/realtime'];
  if (model.startsWith('gpt-audio')) return ['v1/chat/completions'];
  if (model.startsWith('text-embedding')) return ['v1/embeddings'];
  if (model.startsWith('omni-moderation')) return ['v1/moderations'];
  return ['v1/responses'];
}

function modelPage(model: string): string {
  return 'Model ID: \x60' + model + '\x60\n' + (model.includes('realtime-2.1') ? 'Configurable reasoning effort.\n' : '') +
    routes(model).map(endpoint => '| API | \x60' + endpoint + '\x60 | Supported |').join('\n') +
    '\n| API | \x60v1/images/generations\x60 | Not supported |\n';
}

test('public inventory identifies the current modalities and their exact documented controls', () => {
  const { ids, excluded } = publicModelIds(index, deprecated);
  assert.deepEqual(ids.slice().sort(), docModels.slice().sort());
  for (const model of [...restricted, ...obsolete]) assert.ok(excluded.includes(model), model);
  const realtime = documentedModel('gpt-realtime-2.1-mini', modelPage('gpt-realtime-2.1-mini'), rt, quality);
  assert.deepEqual(realtime.efforts, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(realtime.quality, []);
  const image = documentedModel('gpt-image-2.6-flare', modelPage('gpt-image-2.6-flare'), rt, quality);
  assert.deepEqual(image.efforts, []);
  assert.deepEqual(image.quality, ['low', 'medium', 'high', 'xhigh', 'max']);
  const sol = documentedModel('gpt-6.2-sol', modelPage('gpt-6.2-sol'), rt, quality, reasoning);
  assert.deepEqual(sol.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  const solWithoutList = modelPage('gpt-6.2-sol') + 'The API rejects requests that set reasoning effort to \x60none\x60.';
  assert.deepEqual(documentedModel('gpt-6.2-sol', solWithoutList, rt, quality).efforts, sol.efforts);
  const terra = 'Model ID: \x60gpt-6.1-terra\x60\n' +
    '\x60reasoning.effort\x60 supports \x60none\x60, \x60low\x60, \x60medium\x60 (default), \x60high\x60,\n' +
    '\x60xhigh\x60, and \x60max\x60.\n\n| API | \x60v1/responses\x60 | Supported |';
  assert.deepEqual(documentedModel('gpt-6.1-terra', terra, rt, quality).efforts, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.throws(() => completeProjectModels({ status: 'observed', coverage: 'partial', models: [] }), /incomplete/);
});

test('public inventory distinguishes project visibility from job routing and retains the last complete list', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-public-models-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fake = path.join(home, 'project.mjs');
  const replyFile = path.join(home, 'reply.json');
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({ organization_id: 'org-test', project_id: 'proj-test' }));
  fs.writeFileSync(fake, "import fs from 'node:fs'; process.stdout.write(fs.readFileSync(process.argv[2]));");
  const command = { file: process.execPath, prefix: [fake, replyFile] };
  const write = (coverage: string, models: string[]) => fs.writeFileSync(replyFile, JSON.stringify({
    status: 'observed', coverage, inference_required: false, models: models.map(id => ({ id })),
  }));
  const fetchDocs = async (input: string) => {
    const url = new URL(input);
    let body = '';
    if (url.pathname.endsWith('/models/all.md')) body = index;
    else if (url.pathname.endsWith('/deprecations.md')) body = deprecated;
    else if (url.pathname.endsWith('/client-events.md')) body = rt;
    else if (url.pathname.endsWith('/image-generation.md')) body = quality;
    else if (url.pathname.endsWith('/latest-model.md')) body = reasoning;
    else body = modelPage(path.basename(url.pathname, '.md'));
    return new Response(body);
  };
  const lineFor = (model: string) => openAIPublicModelLines(home, home, new Set(['gpt-6.2-sol']))
    .find(line => line.includes(' ' + model + ';')) ?? '';

  write('complete', [...docModels, ...restricted, 'ft:gpt-6-luna:private-org:test']);
  await refreshPublicInventory(home, home, command, fetchDocs);
  for (const model of publicModels) assert.match(lineFor(model), /project listed/);
  for (const model of [...restricted, ...obsolete]) assert.equal(lineFor(model), '');
  assert.match(lineFor('gpt-6.2-sol'), /Responses job/);
  assert.match(lineFor('gpt-audio-1.5'), /inventory only/);
  assert.match(lineFor('text-embedding-3-small'), /central helper only/);
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'openai-public-inventory.json'), 'utf8'), /private-org|org-test|proj-test/);

  write('partial', []);
  await refreshPublicInventory(home, home, command, fetchDocs);
  assert.match(lineFor('gpt-live-1.1'), /project listed \(last read, stale\)/);
  assert.match(publicInventorySummary(home, home).join('\n'), /project model list: stale/);

  write('complete', docModels.filter(model => model !== 'gpt-live-1.1'));
  await refreshPublicInventory(home, home, command, fetchDocs);
  assert.match(lineFor('gpt-live-1.1'), /project absent/);
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({ organization_id: 'org-test', project_id: 'proj-other' }));
  assert.match(lineFor('gpt-live-1.1'), /project unverified/);
  assert.match(publicInventorySummary(home, home).join('\n'), /project model list: unavailable/);
});

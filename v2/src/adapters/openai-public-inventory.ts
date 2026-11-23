import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson, defaultOpenAIHelperRoot, fetchDocsPage, isRestrictedOpenAIModel, type PageFetch } from './openai-models.ts';
import { helperCall } from './shared.ts';
import { supersededBy } from './inventory.ts';
import type { RouteCommand } from './types.ts';

const DOCS = 'https://developers.openai.com/api/docs';
const INDEX = DOCS + '/models/all';
const REALTIME = 'https://developers.openai.com/api/reference/resources/realtime/client-events';
const ID = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'auto']);
const MAX_AGE = 26 * 60 * 60 * 1000; // Daily collection plus time for transient retries.

interface PublicModel {
  model: string;
  source: string;
  endpoints: string[];
  efforts: string[];
  quality: string[];
}
interface Observation {
  attempted: string;
  observed?: string;
  error?: string;
}
interface ProjectObservation extends Observation {
  scope: string;
  models?: string[];
}
interface Inventory {
  documentation?: Observation;
  models?: PublicModel[];
  project?: ProjectObservation;
  excluded?: string[];
}

const statusFile = (home: string) => path.join(home, 'openai-public-inventory.json');
export function readPublicInventory(home: string): Inventory {
  try {
    const status = JSON.parse(fs.readFileSync(statusFile(home), 'utf8'));
    return status && typeof status === 'object' && !Array.isArray(status) ? status : {};
  } catch { return {}; }
}

function projectScope(root: string): string {
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'policy.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (typeof policy.organization_id !== 'string' || typeof policy.project_id !== 'string')
    throw new Error('central helper project scope is unavailable');
  return createHash('sha256').update(JSON.stringify([path.resolve(root), policy.organization_id, policy.project_id])).digest('hex');
}
function markedLevels(text: string): string[] {
  return [...new Set([...text.matchAll(/\x60"?([a-z]+)"?\x60/g)].map(match => match[1]).filter(level => LEVELS.has(level)))];
}

export function publicModelIds(index: string, deprecations: string): { ids: string[]; excluded: string[] } {
  if (!/^## Upcoming deprecations/m.test(deprecations)) throw new Error('unrecognized OpenAI deprecations document');
  const excluded = new Set<string>();
  for (const line of deprecations.split(/\r?\n/)) {
    const cells = line.trim().split('|');
    // Only the affected item is in column two; column four can name a replacement.
    if (cells.length < 5 || !/^\s*\*{0,2}[A-Z][a-z]{2} \d/.test(cells[1])) continue;
    for (const [, model] of cells[2].matchAll(/\x60([a-z0-9._-]+)\x60/g)) excluded.add(model);
  }
  if (!excluded.size) throw new Error('empty OpenAI deprecations table');
  const ids = new Set<string>();
  let section = '';
  for (const line of index.split(/\r?\n/)) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) section = heading[1];
    if (!/^\s*[-*]\s+\[/.test(line)) continue;
    const model = /\/api\/docs\/models\/([a-z0-9._-]+?)(?:\.md)?(?=[)#? \t])/.exec(line)?.[1];
    if (!model || !ID.test(model) || !model.includes('-')) continue;
    if (/daybreak|trusted access|life sciences|deprecated/i.test(section) || isRestrictedOpenAIModel(model) ||
        /\): Older embedding model\b/i.test(line)) {
      excluded.add(model);
    } else if (section && !/open-weight|chatgpt models/i.test(section)) {
      ids.add(model);
    }
  }
  const listed = [...ids];
  if (!listed.some(model => /^gpt-\d/.test(model)) ||
      !listed.some(model => /^gpt-(?:live|realtime|audio)-/.test(model)) ||
      !listed.some(model => model.startsWith('text-embedding-')))
    throw new Error('incomplete or unrecognized OpenAI model index');
  const current = [...ids].filter(model => !excluded.has(model));
  for (const model of current) if (supersededBy(model, current)) excluded.add(model);
  return { ids: current.filter(model => !excluded.has(model)), excluded: [...excluded].sort() };
}

export function documentedModel(model: string, markdown: string, realtime: string, image: string, reasoning = ''): PublicModel {
  const quoted = String.fromCharCode(96) + model + String.fromCharCode(96);
  if (!markdown.includes('Model ID: ' + quoted) && !markdown.includes('Default snapshot: ' + quoted))
    throw new Error('model page does not identify ' + model);
  const endpoints = [...new Set([...markdown.matchAll(/^\|\s*[^|\r\n]+\|\s*\x60(v1\/[a-z_/]+)\x60\s*\|\s*Supported\s*\|/gm)]
    .map(match => '/' + match[1]))];
  if (!endpoints.length) throw new Error('no supported endpoints documented for ' + model);
  const explicit = /(?:reasoning\.effort|reasoning effort)\x60?\s+(?:supports|accepts):?\s+([^\n.]+(?:\r?\n(?!\s*\r?\n)[^.]+)?)/i.exec(markdown)?.[1] ?? '';
  let efforts = [...new Set((explicit.match(/\b[a-z]+\b/g) ?? []).filter(level => LEVELS.has(level)))];
  if (!efforts.length && /^gpt-6\.2-(?:astra|sol)$/.test(model)) {
    const guide = /GPT-6\.2 Astra, GPT-6\.2 Sol,[\s\S]{0,120}?\bsupport ([^.]+)/.exec(reasoning)?.[1] ?? '';
    efforts = markedLevels(guide);
    // The model pages currently document rejection of "none" but sometimes omit the supported list.
    // Retain the verified GPT-6.2 settings when the official guide no longer repeats that list.
    if (!efforts.length && /rejects requests that set reasoning effort to \x60none\x60/i.test(markdown))
      efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  }
  if (!efforts.length && endpoints.includes('/v1/realtime') && /\breasoning model\b|\bconfigurable reasoning effort\b/i.test(markdown)) {
    const reference = /Constrains effort on reasoning for reasoning-capable Realtime models[\s\S]{0,650}/.exec(realtime)?.[0] ?? '';
    efforts = [...reference.matchAll(/^\s+- \x60"([a-z]+)"\x60\s*$/gm)]
      .map(match => match[1]).filter(level => LEVELS.has(level));
  }
  const imageQuality = /quality options are ([^\n]+(?:\r?\n(?!\r?\n)[^.]+)?)/i;
  let quality = markedLevels(imageQuality.exec(markdown)?.[1] ?? '');
  if (!quality.length && /^gpt-image-2\.[56]-(?:flare|sunburst)$/.test(model)) {
    const familyGuide = /For the Sunburst and Flare models in both GPT-Image-2\.6 and GPT-Image-2\.5,\s*the quality options are ([^.]+)/;
    quality = markedLevels(familyGuide.exec(image)?.[1] ?? '');
  }
  return { model, source: DOCS + '/models/' + model, endpoints, efforts, quality };
}

export function completeProjectModels(reply: Record<string, unknown> | null): string[] {
  if (reply?.status !== 'observed' || reply.coverage !== 'complete' ||
      reply.inference_required !== false || !Array.isArray(reply.models))
    throw new Error(typeof reply?.error_code === 'string' && /^[a-z_]+$/.test(reply.error_code)
      ? reply.error_code : 'incomplete OpenAI project catalog');
  const models = reply.models.map(row => typeof row === 'string' ? row : row?.id ?? row?.model_id);
  if (models.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(id)) ||
      new Set(models).size !== models.length) throw new Error('invalid OpenAI project catalog');
  return models.filter(id => ID.test(id) && !isRestrictedOpenAIModel(id)).sort();
}

async function projectModels(helper: RouteCommand, root: string): Promise<string[]> {
  // The original central helper already has an installed, project-bound metadata reader.
  const reader = path.join(root, 'ac_model_catalog', 'v2', 'model_catalog.py');
  const legacy = fs.existsSync(reader);
  const command = legacy ? { file: helper.file, prefix: ['-B', reader], cwd: root } : helper;
  const result = await helperCall(command, legacy ? [] : ['model-catalog'], 25_000, undefined, { PYTHONDONTWRITEBYTECODE: '1' });
  return completeProjectModels(result.reply);
}

export async function refreshPublicInventory(home: string, root: string, helper: RouteCommand, fetchFn: PageFetch = globalThis.fetch): Promise<Inventory> {
  const previous = readPublicInventory(home);
  const at = new Date().toISOString();
  const message = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 300);
  const [docs, project] = await Promise.all([
    (async () => {
      try {
        const [index, deprecated, realtime, image, reasoning] = await Promise.all([
          fetchDocsPage(fetchFn, INDEX), fetchDocsPage(fetchFn, DOCS + '/deprecations'),
          fetchDocsPage(fetchFn, REALTIME), fetchDocsPage(fetchFn, DOCS + '/guides/image-generation'),
          fetchDocsPage(fetchFn, DOCS + '/guides/latest-model'),
        ]);
        const { ids, excluded } = publicModelIds(index, deprecated);
        const models: PublicModel[] = [];
        const missed: string[] = [];
        for (let offset = 0; offset < ids.length; offset += 6) {
          await Promise.all(ids.slice(offset, offset + 6).map(async model => {
            try { models.push(documentedModel(model, await fetchDocsPage(fetchFn, DOCS + '/models/' + model), realtime, image, reasoning)); }
            catch {
              missed.push(model);
              const retained = previous.models?.find(row => row.model === model);
              if (retained) models.push(retained);
            }
          }));
        }
        if (!models.length) throw new Error('no OpenAI model pages could be verified');
        return { models: models.sort((a, b) => a.model.localeCompare(b.model)), excluded,
          documentation: { attempted: at, observed: missed.length ? previous.documentation?.observed : at,
            error: missed.length ? 'Model pages unavailable: ' + missed.sort().join(', ') : undefined } };
      } catch (error) {
        return { models: previous.models, excluded: previous.excluded,
          documentation: { attempted: at, observed: previous.documentation?.observed, error: message(error) } };
      }
    })(),
    (async (): Promise<ProjectObservation> => {
      let scope = '';
      try {
        scope = projectScope(root);
        const models = await projectModels(helper, root);
        if (scope !== projectScope(root)) throw new Error('OpenAI project scope changed during refresh');
        return { attempted: at, observed: at, scope, models };
      } catch (error) {
        const prior = scope && scope === previous.project?.scope ? previous.project : undefined;
        return { ...prior, attempted: at, scope, error: message(error) };
      }
    })(),
  ]);
  const snapshot = { ...docs, project };
  const latest = readPublicInventory(home);
  if ((latest.documentation?.attempted ?? '') > at) return latest;
  fs.mkdirSync(home, { recursive: true });
  atomicJson(statusFile(home), snapshot);
  return snapshot;
}

function current(observation?: Observation): boolean {
  return !!observation?.observed && !observation.error && Date.now() - Date.parse(observation.observed) <= MAX_AGE;
}
export function publicInventorySummary(home: string, root = defaultOpenAIHelperRoot(home)): string[] {
  const snapshot = readPublicInventory(home);
  const summary = (label: string, observation?: Observation) => {
    const state = !observation?.observed ? 'unavailable' : current(observation) ? 'current' : 'stale';
    return label + ': ' + state + '; last complete read ' + (observation?.observed ?? 'none') +
      (observation?.error ? '; ' + observation.error : '');
  };
  let sameProject = false;
  try { sameProject = snapshot.project?.scope === projectScope(root); } catch { /* identity unavailable */ }
  const project = sameProject ? snapshot.project : snapshot.project ? {
    attempted: snapshot.project.attempted, error: 'current project scope is unverified',
  } : undefined;
  return [summary('Official OpenAI model docs', snapshot.documentation), summary('OpenAI project model list', project)];
}

export function openAIPublicModelLines(home: string, root: string, routable: ReadonlySet<string>): string[] {
  const snapshot = readPublicInventory(home);
  let scoped = false;
  try { scoped = snapshot.project?.scope === projectScope(root); } catch { /* identity unavailable */ }
  const project = scoped && snapshot.project?.models ? new Set(snapshot.project.models) : undefined;
  const excluded = new Set(snapshot.excluded ?? []);
  return (snapshot.models ?? []).filter(row => !excluded.has(row.model) && !isRestrictedOpenAIModel(row.model)).map(row => {
    const visibility = project ? (project.has(row.model) ? 'listed' : 'absent') + (current(snapshot.project) ? '' : ' (last read, stale)') : 'unverified';
    const use = routable.has(row.model) ? 'Responses job' : row.model === 'text-embedding-3-small' ? 'central helper only' : 'inventory only';
    return '  PUBLIC ' + row.model + '; ' + use + '; project ' + visibility + '; endpoints ' + row.endpoints.join(', ') +
      '; ' + (row.efforts.length ? 'reasoning effort ' + row.efforts.join(', ') : 'no documented effort setting') +
      (row.quality.length ? '; image quality ' + row.quality.join(', ') : '');
  });
}

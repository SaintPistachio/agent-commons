/**
 * Official-documentation-only OpenAI registry maintenance.
 *
 * No provider requests, admission decisions, reservations or accounting happen here.
 * All pages are parsed before the registry is touched. Existing entries are never removed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compareVersionParts, parseModelVersion, supersededBy } from './inventory.ts';
import { profileGrid, type ProfileSeed } from './types.ts';

const REPO_HELPER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools/openai-capabilities');

/**
 * Resolve the central OpenAI helper root without hardcoding drive letters or external repos.
 * Precedence: AGENT_COMMONS_OPENAI_HELPER_ROOT -> <home>/backup-config.json openaiHelperRoot ->
 * sibling <MainCheckout>/tools/openai-capabilities (when <home> ends with -data) -> repo checkout relative.
 */
export function resolveOpenAIHelperRoot(home?: string, env: NodeJS.ProcessEnv = process.env): { root: string; configured: boolean } {
  const override = env.AGENT_COMMONS_OPENAI_HELPER_ROOT?.trim();
  if (override) return { root: path.resolve(home ?? process.cwd(), override), configured: true };
  let sibling: string | undefined;
  if (home) {
    const resolvedHome = path.resolve(home);
    const configFile = path.join(resolvedHome, 'backup-config.json');
    try {
      const cfg: unknown = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
      if (!object(cfg)) throw new Error('backup-config.json must contain an object');
      if (cfg.openaiHelperRoot != null) {
        if (typeof cfg.openaiHelperRoot !== 'string' || !cfg.openaiHelperRoot.trim()) {
          throw new Error('openaiHelperRoot must be a nonempty path');
        }
        return { root: path.resolve(resolvedHome, cfg.openaiHelperRoot.trim()), configured: true };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const base = path.basename(resolvedHome);
    if (base.length > 5 && base.toLowerCase().endsWith('-data')) {
      sibling = path.join(path.dirname(resolvedHome), base.slice(0, -5), 'tools', 'openai-capabilities');
      if (fs.existsSync(path.join(sibling, 'run.py'))) return { root: sibling, configured: false };
    }
  }
  const root = fs.existsSync(path.join(REPO_HELPER_ROOT, 'run.py')) ? REPO_HELPER_ROOT : sibling ?? REPO_HELPER_ROOT;
  return { root, configured: false };
}

export function defaultOpenAIHelperRoot(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenAIHelperRoot(home, env).root;
}

export const OPENAI_HELPER_ROOT = defaultOpenAIHelperRoot();
const DOCS = 'https://developers.openai.com/api/docs';
const PRICING = `${DOCS}/pricing`;
const INDEX = `${DOCS}/models`;

/** These offerings require separate enrollment or a specialized project. */
export function isRestrictedOpenAIModel(model: string): boolean {
  return /(?:^|[-.])(?:cyber|rosalind|daybreak|law|csam)(?:$|[-.])/i.test(model);
}

type ObjectMap = Record<string, any>;
export type Rates = Record<string, string>;
export interface ModelPrices {
  tiers: Record<string, Rates>;
  long_context_rates: Record<string, Rates>;
}
export interface ParsedPricing {
  models: Record<string, ModelPrices>;
  long_context_threshold?: number;
}
export interface ParsedModel {
  supported: boolean;
  endpoint?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
}
export type PageFetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface RegistryEvent {
  at: string;
  kind: 'added' | 'updated' | 'failure';
  model?: string;
  sources?: string[];
  error?: string;
}
export type OpenAIModality =
  | 'text'
  | 'realtime'
  | 'transcription'
  | 'tts'
  | 'image'
  | 'embeddings'
  | 'moderation'
  | 'video'
  | 'other';

export interface OpenAICatalogEntry {
  model: string;
  modality: OpenAIModality;
  routable: boolean;
  superseded_by?: string;
  pricing: Record<string, string>;
  source: string;
}

export interface RegistryStatus {
  last_attempt_at?: string;
  last_success_at?: string;
  error?: string | null;
  events: RegistryEvent[];
  flagged: string[];
  price_mismatches: Array<{ model: string; at: string; corrected: boolean }>;
  /** Models whose own page could not be verified on the last check; they are skipped, nothing is written for them. */
  skipped?: Array<{ model: string; reason: string }>;
  /** AC-side catalog of every current OpenAI API model (text + non-text modalities with prices). */
  catalog?: OpenAICatalogEntry[];
}

function object(value: unknown): value is ObjectMap {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decimal(value: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value))
    throw new Error(`Invalid positive decimal price: ${value}`);
  const [whole, fraction = ''] = value.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const tail = fraction.replace(/0+$/, '');
  return tail ? `${integer}.${tail}` : integer;
}

function price(value: string): string | undefined {
  const clean = value.trim();
  if (clean === '-') return undefined;
  if (!/^\$\d+(?:\.\d+)?$/.test(clean)) throw new Error(`Unrecognized price: ${value}`);
  return decimal(clean.slice(1));
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function tableRows(markdown: string): string[][] {
  return markdown.split(/\r?\n/).filter(line => line.trim().startsWith('|')).map(cells);
}

function tokenCount(number: string, suffix = ''): number {
  const n = Number(number.replace(/,/g, '')) * ({ K: 1000, M: 1000000 }[suffix.toUpperCase()] ?? 1);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid token count: ${number}${suffix}`);
  return n;
}

/** Only the named token-pricing tables are used; audio/image modalities are not text Responses rates. */
export function parseOpenAIPricing(markdown: string): ParsedPricing {
  const models: Record<string, ModelPrices> = Object.create(null);
  const lines = markdown.split(/\r?\n/);
  let tier: string | undefined;
  let specialized = false;
  const found = new Set<string>();

  const readRates = (headers: string[], row: string[], prefix: string): Rates | undefined => {
    const rates: Rates = {};
    const fields = [
      ['input', 'input'],
      ['output', 'output'],
      ['cached input', 'cache_read'],
      ['30m write', 'cache_write_30m'],
      ['12h write', 'cache_write_12h'],
    ];
    for (const [header, field] of fields) {
      const index = headers.indexOf(prefix + header);
      if (index < 0) continue;
      if (row[index] === undefined) throw new Error('Truncated pricing row');
      const value = price(row[index]);
      if (value !== undefined) rates[field] = value;
    }
    if (!Object.keys(rates).length) return undefined;
    if (!rates.input || !rates.output) throw new Error('Incomplete input/output pricing');
    return rates;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === 'Specialized models') { specialized = true; tier = undefined; }
    if (['Multimodal models', 'Tools', 'Cloud platforms', 'Fine-tuning'].includes(line)) {
      specialized = false;
      tier = undefined;
    }
    const heading = /^### (Standard|Batch|Flex|Fast|Ultrafast(?: promotion| list)?) pricing data$/.exec(line);
    if (heading) {
      specialized = false;
      tier = ({ Standard: 'default', Batch: 'batch', Flex: 'flex' } as Record<string, string>)[heading[1]];
      if (tier) found.add(tier);
    } else if (/^#{1,4}\s/.test(line)) {
      specialized = false;
      tier = undefined;
    } else if (specialized && ['Standard', 'Batch', 'Flex', 'Fast'].includes(line)) {
      tier = ({ Standard: 'default', Batch: 'batch', Flex: 'flex' } as Record<string, string>)[line];
    }
    if (!tier || !line.startsWith('|')) continue;
    const headers = cells(line).map(value => value.toLowerCase());
    const modelColumn = headers.indexOf('model');
    if (modelColumn < 0 || headers.includes('modality')) continue;
    if (!(headers.includes('input') && headers.includes('output'))
      && !(headers.includes('short context input') && headers.includes('short context output'))) continue;
    if (!/^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? '')) throw new Error('Malformed pricing table');
    i += 2;
    for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      const row = cells(lines[i]);
      const match = /^(gpt-[a-z0-9.-]+)(?:\s+\(([^)]+)\))?$/.exec(row[modelColumn] ?? '');
      if (!match) continue;
      const model = match[1];
      const wide = headers.includes('short context input');
      const short = readRates(headers, row, wide ? 'short context ' : '');
      const long = wide ? readRates(headers, row, 'long context ') : undefined;
      if (!short && !long) continue;
      const entry = models[model] ??= { tiers: {}, long_context_rates: {} };
      const put = (destination: Record<string, Rates>, rates: Rates | undefined) => {
        if (!rates) return;
        if (destination[tier!] && JSON.stringify(destination[tier!]) !== JSON.stringify(rates))
          throw new Error(`Conflicting ${tier} prices for ${model}`);
        destination[tier!] = rates;
      };
      if (!wide && match[2]?.toLowerCase() === 'long context') put(entry.long_context_rates, short);
      else {
        put(entry.tiers, short);
        put(entry.long_context_rates, long);
      }
    }
    i--;
  }
  if (!found.has('default') || !found.has('batch')
    || !Object.values(models).some(model => model.tiers.default)
    || !Object.values(models).some(model => model.tiers.batch))
    throw new Error('Missing Standard or Batch pricing tables');

  const split = /Short context:\s*(?:≤|<=)\s*([\d,.]+)\s*([KM]?)\s*input tokens\.\s*Long context:\s*>\s*([\d,.]+)\s*([KM]?)\s*input tokens/i.exec(markdown);
  let threshold: number | undefined;
  if (split) {
    threshold = tokenCount(split[1], split[2]);
    if (threshold !== tokenCount(split[3], split[4])) throw new Error('Inconsistent context split');
  }
  if (Object.values(models).some(model => Object.keys(model.long_context_rates).length) && threshold === undefined)
    throw new Error('Long-context prices have no documented context split');
  return { models, ...(threshold === undefined ? {} : { long_context_threshold: threshold }) };
}

export function parseOpenAIModelIndex(markdown: string): Set<string> {
  if (!/^# Models\s*$/m.test(markdown)) throw new Error('Missing models index heading');
  const ids = new Set<string>();
  for (const match of markdown.matchAll(/\/api\/docs\/models\/(gpt-[a-z0-9.-]+?)(?:\.md)?(?=[)#?\s])/gi))
    ids.add(match[1]);
  for (const match of markdown.matchAll(/Model ID:\s*`(gpt-[a-z0-9.-]+)`/gi)) ids.add(match[1]);
  if (!ids.size) throw new Error('No model IDs in models index');
  return ids;
}

export function parseOpenAIModelPage(markdown: string, model: string): ParsedModel {
  const id = /Model ID:\s*`([^`]+)`/.exec(markdown)?.[1];
  if (id !== model) throw new Error(`Model page identity mismatch: expected ${model}, got ${id ?? 'none'}`);
  const endpoints = tableRows(markdown).filter(row => row[0] === 'Responses');
  if (endpoints.length !== 1) throw new Error(`Missing or ambiguous Responses endpoint for ${model}`);
  const row = endpoints[0];
  const route = row[1]?.replace(/`/g, '');
  if (route !== 'v1/responses' && route !== '/v1/responses') throw new Error(`Invalid Responses route for ${model}`);
  if (row[2] === 'Not supported') return { supported: false };
  if (row[2] !== 'Supported') throw new Error(`Unrecognized Responses support for ${model}`);
  const input = /Maximum input tokens:\s*([\d,]+)/i.exec(markdown);
  const output = /([\d,]+)\s+max output tokens/i.exec(markdown);
  if (!input || !output) throw new Error(`Missing token limits for ${model}`);
  const maxInput = tokenCount(input[1]);
  const maxOutput = tokenCount(output[1]);
  if (maxOutput > 200000) throw new Error(`Output limit exceeds registration safety bound for ${model}`);
  return { supported: true, endpoint: '/' + route.replace(/^\//, ''), max_input_tokens: maxInput, max_output_tokens: maxOutput };
}

/** The helper uses either a direct model map or a models container. Preserve either layout. */
export function registryModelMap(registry: unknown): ObjectMap {
  if (!object(registry)) throw new Error('Registry must be an object');
  if (registry.models !== undefined) {
    if (!object(registry.models)) throw new Error('Unrecognized registry models container');
    return registry.models;
  }
  return registry;
}

export function responsesRegistryModels(registry: unknown): Array<{ model: string; responses: ObjectMap }> {
  return Object.entries(registryModelMap(registry)).flatMap(([model, entry]) =>
    object(entry) && object(entry.capabilities) && object(entry.capabilities.responses)
      ? [{ model, responses: entry.capabilities.responses }] : []);
}

export function readOpenAIRegistry(root = defaultOpenAIHelperRoot()): ObjectMap {
  return JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
}

export function openAIModelVersion(model: string): { line: string; version: number[] } | undefined {
  const match = /^gpt-(\d+(?:\.\d+)*)-([a-z][a-z0-9-]*)$/.exec(model);
  const parsed = match ? parseModelVersion(model) : undefined;
  return match && parsed && parsed.line === `gpt-${match[2]}`
    ? { line: match[2], version: parsed.parts }
    : undefined;
}

export function newestOpenAILines(registry: unknown): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const { model } of responsesRegistryModels(registry)) {
    if (isRestrictedOpenAIModel(model)) continue;
    const parsed = openAIModelVersion(model);
    if (!parsed) continue;
    const previous = selected[parsed.line];
    if (!previous || compareVersionParts(parsed.version, openAIModelVersion(previous)!.version) > 0) selected[parsed.line] = model;
  }
  return selected;
}

const MODALITY_ORDER: Record<OpenAIModality, number> = {
  text: 0, realtime: 1, transcription: 2, tts: 3, image: 4, embeddings: 5, moderation: 6, video: 7, other: 8,
};

function inferOpenAIModality(model: string, headingText: string, modalityCell?: string): OpenAIModality {
  const cell = (modalityCell ?? '').trim().toLowerCase();
  const id = model.toLowerCase();
  const heading = headingText.toLowerCase();
  if (/realtime|audio-preview/.test(id) || (cell === 'audio' && /realtime|voice/.test(heading))) return 'realtime';
  if (/transcribe|whisper/.test(id)) return 'transcription';
  if (/\btts\b/.test(id)) return 'tts';
  if (/\bimage\b|dall-e/.test(id)) return 'image';
  if (/embedding/.test(id)) return 'embeddings';
  if (/moderation/.test(id)) return 'moderation';
  if (/sora|\bvideo\b/.test(id)) return 'video';
  if (cell === 'text') return 'text';
  if (cell === 'image') return 'image';
  if (cell === 'video') return 'video';
  if (/realtime|voice/.test(heading)) return 'realtime';
  if (/transcription|speech[\s-]+to[\s-]+text/.test(heading)) return 'transcription';
  if (/text[\s-]+to[\s-]+speech|\btts\b/.test(heading)) return 'tts';
  if (/\bimages?\b/.test(heading)) return 'image';
  if (/embedding/.test(heading)) return 'embeddings';
  if (/moderation/.test(heading)) return 'moderation';
  if (/\bvideo\b|sora/.test(heading)) return 'video';
  if (cell === 'audio') return 'realtime';
  if (/\b(standard|batch|flex|fast|ultrafast|text|responses)\b/.test(heading) && !/multimodal/.test(heading)) return 'text';
  return /^gpt-|^o\d/.test(id) ? 'text' : 'other';
}

function cleanCatalogModelId(raw: string): { model: string; qualifier: string } | undefined {
  const trimmed = raw.trim();
  const link = /^\[([^\]]+)\]\(([^)]+)\)(?:\s*\(([^)]+)\))?$/.exec(trimmed);
  let base = trimmed;
  let qualifier = '';
  if (link) {
    const slug = /\/models\/([a-z0-9._-]+?)(?:\.md)?$/i.exec(link[2])?.[1];
    base = slug ?? link[1];
    qualifier = link[3] ?? '';
  } else {
    const qual = /^(.*?)\s*\(([^)]+)\)$/.exec(trimmed);
    if (qual) {
      base = qual[1].trim();
      qualifier = qual[2].trim();
    }
  }
  base = base.replace(/`/g, '').trim();
  if (!/^(?=.*[0-9-])[a-z0-9][a-z0-9._-]{1,63}$/i.test(base)) return undefined;
  return { model: base, qualifier: qualifier.toLowerCase() };
}

function capabilityModality(capability: string): OpenAIModality {
  const key = capability.toLowerCase();
  if (key === 'responses' || key === 'decisions') return 'text';
  if (key === 'embeddings') return 'embeddings';
  if (key === 'images' || key === 'image') return 'image';
  if (key === 'realtime' || key === 'audio' || key === 'voice') return 'realtime';
  if (key === 'transcription') return 'transcription';
  if (key === 'tts' || key === 'speech') return 'tts';
  if (key === 'moderation') return 'moderation';
  if (key === 'video') return 'video';
  return 'other';
}

/**
 * Builds the AC-side OpenAI API model catalog from official pricing + models index Markdown (plus any helper registry
 * entries), keeping non-text modalities and superseded text versions known-but-not-routable (`routable: false`).
 */
export function parseOpenAICatalog(
  pricingMarkdown: string,
  indexMarkdown: string,
  routableResponses: Iterable<string> = [],
  registry?: unknown,
): OpenAICatalogEntry[] {
  const entries = new Map<string, OpenAICatalogEntry>();
  const upsert = (model: string, modality: OpenAIModality, pricing: Record<string, string>, source: string) => {
    const key = `${modality}:${model}`;
    const existing = entries.get(key);
    if (existing) {
      Object.assign(existing.pricing, pricing);
      return;
    }
    entries.set(key, { model, modality, routable: false, pricing: { ...pricing }, source });
  };

  const lines = pricingMarkdown.split(/\r?\n/);
  let h1 = '', h2 = '', h3 = '', sub = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^# /.test(line)) { h1 = line.slice(2).trim(); h2 = ''; h3 = ''; sub = ''; continue; }
    if (/^## /.test(line)) { h2 = line.slice(3).trim(); h3 = ''; sub = ''; continue; }
    if (/^### /.test(line)) { h3 = line.slice(4).trim(); sub = ''; continue; }
    if (/^#### /.test(line)) { sub = line.slice(5).trim(); continue; }
    if (/^[A-Za-z][A-Za-z0-9 -]{2,40}$/.test(line) && !line.startsWith('|')) { sub = line; continue; }
    if (!line.startsWith('|')) continue;

    const headers = cells(line).map(h => h.toLowerCase());
    const modelCol = headers.findIndex(h => h === 'model' || h === 'model id');
    if (modelCol < 0 || !/^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? '')) continue;
    const modalityCol = headers.indexOf('modality');
    const headingText = [h1, h2, h3, sub].filter(Boolean).join(' / ');
    const tierHeading = (h3 || sub).toLowerCase();
    const tierKey = /\bultrafast\s+promotion\b/.test(tierHeading) ? 'ultrafast_promotion.'
      : /\bultrafast\s+list\b/.test(tierHeading) ? 'ultrafast_list.'
      : /\bultrafast\b/.test(tierHeading) ? 'ultrafast.'
      : /\bbatch\b/.test(tierHeading) ? 'batch.'
      : /\bflex\b/.test(tierHeading) ? 'flex.'
      : /\bfast\b/.test(tierHeading) ? 'fast.'
      : '';

    i += 2;
    for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      const row = cells(lines[i]);
      const parsedId = cleanCatalogModelId(row[modelCol] ?? '');
      if (!parsedId) continue;
      const modalityCell = modalityCol >= 0 ? row[modalityCol] : undefined;
      const modality = inferOpenAIModality(parsedId.model, headingText, modalityCell);
      const longPrefix = parsedId.qualifier === 'long context' ? 'long_' : '';
      const pricing: Record<string, string> = {};
      for (let col = 0; col < headers.length; col++) {
        if (col === modelCol || col === modalityCol) continue;
        const rawVal = (row[col] ?? '').trim();
        if (!rawVal || rawVal === '-' || /^n\/a$/i.test(rawVal) || /^not supported$/i.test(rawVal)) continue;
        const field = headers[col].replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!field) continue;
        pricing[`${tierKey}${longPrefix}${field}`] = rawVal;
      }
      upsert(parsedId.model, modality, pricing, PRICING);
    }
    i--;
  }

  for (const match of indexMarkdown.matchAll(/\/api\/docs\/models\/([a-z0-9._-]+?)(?:\.md)?(?=[)#?\s])/gi)) {
    const model = match[1];
    const modality = inferOpenAIModality(model, '');
    if (![...entries.values()].some(e => e.model === model)) upsert(model, modality, {}, INDEX);
  }
  for (const match of indexMarkdown.matchAll(/Model ID:\s*`([a-z0-9._-]+)`/gi)) {
    const model = match[1];
    const modality = inferOpenAIModality(model, '');
    if (![...entries.values()].some(e => e.model === model)) upsert(model, modality, {}, INDEX);
  }

  if (registry && object(registry)) {
    for (const [model, details] of Object.entries(registryModelMap(registry))) {
      if (!object(details) || !object(details.capabilities)) continue;
      for (const [cap, spec] of Object.entries(details.capabilities)) {
        const modality = capabilityModality(cap);
        const defaultRates = object(spec) && object(spec.tiers) && object(spec.tiers.default)
          ? Object.fromEntries(Object.entries(spec.tiers.default).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, `$${v}`]))
          : {};
        if (![...entries.values()].some(e => e.model === model && e.modality === modality))
          upsert(model, modality, defaultRates, 'helper-registry');
      }
    }
  }

  const routableSet = new Set(routableResponses);
  const activeText = [...entries.values()]
    .filter(e => e.modality === 'text' && routableSet.has(e.model))
    .map(e => e.model);
  const byModality = new Map<OpenAIModality, string[]>();
  for (const e of entries.values()) {
    const list = byModality.get(e.modality) ?? [];
    list.push(e.model);
    byModality.set(e.modality, list);
  }
  const out = [...entries.values()].map(entry => {
    const copy: OpenAICatalogEntry = { ...entry };
    if (entry.modality === 'text') {
      const sup = supersededBy(entry.model, activeText);
      if (sup) { copy.superseded_by = sup; copy.routable = false; }
      else copy.routable = routableSet.has(entry.model);
    } else {
      copy.routable = false;
      const sup = supersededBy(entry.model, byModality.get(entry.modality) ?? []);
      if (sup) copy.superseded_by = sup;
    }
    return copy;
  });
  return out.sort((a, b) => (MODALITY_ORDER[a.modality] - MODALITY_ORDER[b.modality]) || a.model.localeCompare(b.model));
}

function openAIProfileLine(intent: ProfileSeed['intent'], eff: ProfileSeed['eff']): 'luna' | 'terra' | 'sol' | 'astra' {
  if (eff === 'max') return 'astra';
  if (intent === 'fast' && eff !== 'high') return 'luna';
  if ((intent === 'fast' && eff === 'high') || (intent === 'code' && (eff === 'min' || eff === 'low' || eff === 'med'))) return 'terra';
  return 'sol';
}

export function registryRatesForModel(registry: unknown, model: string, tier = 'default'): { input: number; output: number } | null {
  const entry = registryModelMap(registry)[model];
  const tiers = object(entry) && object(entry.capabilities) && object(entry.capabilities.responses) && object(entry.capabilities.responses.tiers)
    ? entry.capabilities.responses.tiers : undefined;
  const spec = tiers && object(tiers[tier]) ? tiers[tier] : tiers && object(tiers.default) ? tiers.default : undefined;
  if (!spec) return null;
  const input = Number(spec.input ?? spec.short_context_input);
  const output = Number(spec.output ?? spec.short_context_output);
  return Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0 ? { input, output } : null;
}

export function openAIProfileSeeds(registry: unknown): ProfileSeed[] {
  const fallback = object(registry) && registry.__agentCommonsFallback === true;
  const lines = fallback
    ? { sol: 'gpt-6.2-sol', terra: 'gpt-6.1-terra', luna: 'gpt-6-luna', astra: 'gpt-6.2-astra' }
    : newestOpenAILines(registry);
  return profileGrid(['advice'],
    (intent, eff) => {
      const line = openAIProfileLine(intent, eff);
      return lines[line] ?? (line === 'terra' ? lines.sol : undefined) ?? null;
    },
    { min: 'low', low: 'low', med: 'medium', high: 'high', max: 'max' },
    fallback ? () => ({ model_source: 'fallback' }) : undefined, (_intent, eff) => ({
      native_model: 'gpt-6-luna',
      native_effort: { min: 'low', low: 'low', med: 'medium', high: 'high', max: 'high' }[eff],
    })).map(seed => ({
      ...seed,
      previousSeeds: [
        {
          native_model: seed.intent === 'fast' && (seed.eff === 'min' || seed.eff === 'low') ? 'gpt-6-luna' : 'gpt-6.1-sol',
          native_effort: seed.effort,
        },
        {
          native_model: seed.intent === 'fast' && (seed.eff === 'min' || seed.eff === 'low') ? 'gpt-6-luna'
            : seed.eff === 'max' ? 'gpt-6.2-astra' : 'gpt-6.2-sol',
          native_effort: seed.effort,
        },
      ],
    }));
}

export function initialOpenAIRegistry(): ObjectMap {
  try { return readOpenAIRegistry(); }
  catch {
    // This marker supplies startup defaults only, never discovery or verification evidence.
    return { __agentCommonsFallback: true };
  }
}

function statusFile(home: string): string { return path.join(home, 'openai-models.json'); }

export function readOpenAIModelStatus(home: string): RegistryStatus {
  try {
    const value = JSON.parse(fs.readFileSync(statusFile(home), 'utf8'));
    if (!object(value) || !Array.isArray(value.events) || !Array.isArray(value.flagged) || !Array.isArray(value.price_mismatches))
      throw new Error('Invalid model synchronization status');
    return value as RegistryStatus;
  } catch {
    return { events: [], flagged: [], price_mismatches: [] };
  }
}

/** A same-directory, exclusive temporary file; the destination never contains partial JSON. */
export function atomicJson(file: string, value: unknown, mode = 0o600): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* renamed, or not created */ }
  }
}

function normalizedPrices(response: ObjectMap): unknown {
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      try { return decimal(value); } catch { return value; }
    }
    if (!object(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  };
  return normalize({
    tiers: response.tiers ?? {},
    long_context_rates: response.long_context_rates ?? {},
    long_context_threshold: response.long_context_threshold ?? null,
  });
}

function templateArrays(registry: unknown): Pick<ObjectMap, 'allowed_fields' | 'input_modalities' | 'cache_ttls'> {
  for (const { responses } of responsesRegistryModels(registry)) {
    if (['allowed_fields', 'input_modalities', 'cache_ttls'].every(field =>
      Array.isArray(responses[field]) && responses[field].length && responses[field].every((value: unknown) => typeof value === 'string'))
      && responses.input_modalities.includes('text')) {
      return {
        allowed_fields: [...responses.allowed_fields],
        input_modalities: ['text'],
        cache_ttls: [...responses.cache_ttls],
      };
    }
  }
  throw new Error('No existing Responses entry supplies verified request fields and cache TTLs');
}

export interface SynchronizeOptions {
  home: string;
  root?: string;
  fetch?: PageFetch;
  now?: () => Date;
  excluded?: readonly string[];
}

export async function fetchDocsPage(fetchFn: PageFetch, url: string): Promise<string> {
  const response = await fetchFn(url + '.md', {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'AgentCommons/2' },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const body = await response.text();
  if (!body.trim() || body.length > 8000000) throw new Error(`${url}: empty or oversized page`);
  return body;
}

function saveModelStatus(home: string, status: RegistryStatus): RegistryStatus {
  fs.mkdirSync(home, { recursive: true });
  atomicJson(statusFile(home), status);
  return status;
}

function catalogFromDocs(
  pricingPage: string,
  indexPage: string,
  registry: unknown,
  flagged: readonly string[],
): OpenAICatalogEntry[] {
  const flaggedSet = new Set(flagged);
  const routable = registry
    ? responsesRegistryModels(registry).map(({ model }) => model).filter(model => !flaggedSet.has(model))
    : [];
  return parseOpenAICatalog(pricingPage, indexPage, routable, registry);
}

/**
 * Read-only AC-side catalog refresh: fetches pricing and models index pages and reads the helper registry
 * without modifying `registry.json` or running any provider request.
 */
export async function refreshOpenAICatalog(options: SynchronizeOptions): Promise<RegistryStatus> {
  const root = options.root ?? defaultOpenAIHelperRoot(options.home);
  const at = (options.now?.() ?? new Date()).toISOString();
  const status = readOpenAIModelStatus(options.home);
  status.last_attempt_at = at;
  const fetchFn = options.fetch ?? globalThis.fetch;
  try {
    const [pricingPage, indexPage] = await Promise.all([fetchDocsPage(fetchFn, PRICING), fetchDocsPage(fetchFn, INDEX)]);
    let registry: unknown;
    try { registry = readOpenAIRegistry(root); } catch { /* optional if helper registry is unavailable */ }
    status.catalog = catalogFromDocs(pricingPage, indexPage, registry, status.flagged);
    status.error = null;
    status.last_success_at = at;
    return saveModelStatus(options.home, status);
  } catch (error) {
    status.error = String((error as Error)?.message ?? error);
    status.events.push({ at, kind: 'failure', error: status.error });
    saveModelStatus(options.home, status);
    throw error;
  }
}

/**
 * An unsuccessful fetch/parse/identity/limit check aborts the entire registry transaction.
 * The lock protects concurrent Commons writers; a byte comparison also detects outside edits.
 */
export async function synchronizeOpenAIModels(options: SynchronizeOptions): Promise<RegistryStatus> {
  const root = options.root ?? defaultOpenAIHelperRoot(options.home);
  const file = path.join(root, 'registry.json');
  const at = (options.now?.() ?? new Date()).toISOString();
  const status = readOpenAIModelStatus(options.home);
  status.last_attempt_at = at;
  const fetchPage = (url: string) => fetchDocsPage(options.fetch ?? globalThis.fetch, url);
  try {
    const original = fs.readFileSync(file, 'utf8');
    const registry = JSON.parse(original);
    const models = registryModelMap(registry);
    const [pricingPage, indexPage] = await Promise.all([
      fetchPage(PRICING), fetchPage(INDEX),
    ]);
    const pricing = parseOpenAIPricing(pricingPage);
    const index = parseOpenAIModelIndex(indexPage);
    const excluded = new Set(options.excluded ?? []);
    const candidates = [...index].filter(model => !isRestrictedOpenAIModel(model) && !excluded.has(model) && pricing.models[model]?.tiers.default).sort();
    if (!candidates.length) throw new Error('No indexed models have Standard pricing');
    // One model whose page lacks a verifiable fact (for example an older model with no token limits) is skipped
    // on its own; it never blocks the other models. Require at least one verified Responses model before publishing.
    const skipped: Array<{ model: string; reason: string }> = [];
    const parsed = (await Promise.all(candidates.map(async model => {
      try {
        const markdown = await fetchPage(`${INDEX}/${model}`);
        const page = parseOpenAIModelPage(markdown, model);
        const pageSplit = /more than\s+([\d,.]+)\s*([KM]?)\s+input tokens/i.exec(markdown);
        if (pageSplit && Object.keys(pricing.models[model].long_context_rates).length
          && tokenCount(pageSplit[1], pageSplit[2]) !== pricing.long_context_threshold)
          throw new Error(`Model/pricing context split mismatch for ${model}`);
        return { model, page };
      } catch (error) {
        skipped.push({ model, reason: String((error as Error)?.message ?? error) });
        return null;
      }
    }))).filter((row): row is { model: string; page: ReturnType<typeof parseOpenAIModelPage> } => row !== null);
    if (!parsed.some(row => row.page.supported)) throw new Error('No priced Responses model could be verified');
    status.skipped = skipped.sort((a, b) => a.model.localeCompare(b.model));
    const arrays = templateArrays(registry);
    const changes: Array<{ model: string; entry: ObjectMap; event: RegistryEvent; mismatch: boolean }> = [];
    for (const { model, page } of parsed) {
      if (!page.supported) continue;
      const prices = pricing.models[model];
      const hasLong = Object.keys(prices.long_context_rates).length > 0;
      const sources = [PRICING, INDEX, `${INDEX}/${model}`];
      const entry: ObjectMap = {
        endpoint: page.endpoint,
        verified_at: at.slice(0, 10),
        tiers: prices.tiers,
        ...(hasLong ? {
          long_context_threshold: pricing.long_context_threshold,
          long_context_rates: prices.long_context_rates,
        } : {}),
        max_input_tokens: page.max_input_tokens,
        max_output_tokens: page.max_output_tokens,
        ...arrays,
        sources,
      };
      const previous = models[model]?.capabilities?.responses;
      const mismatch = !!previous && JSON.stringify(normalizedPrices(previous)) !== JSON.stringify(normalizedPrices(entry));
      if (!object(previous) || mismatch
        || previous.max_input_tokens !== entry.max_input_tokens || previous.max_output_tokens !== entry.max_output_tokens) {
        changes.push({ model, entry, mismatch, event: { at, kind: object(previous) ? 'updated' : 'added', model, sources } });
      }
    }

    const supported = new Set(parsed.filter(row => row.page.supported).map(row => row.model));
    status.flagged = responsesRegistryModels(registry)
      .filter(({ model }) => model.startsWith('gpt-') && (!index.has(model) || !pricing.models[model]?.tiers.default || !supported.has(model)))
      .map(({ model }) => model).sort();

    if (changes.length) {
      const lock = file + '.ac-lock';
      const lockFd = fs.openSync(lock, 'wx', 0o600);
      try {
        if (fs.readFileSync(file, 'utf8') !== original) throw new Error('Registry changed during verification; refresh again');
        for (const change of changes) {
          const previous = models[change.model];
          models[change.model] = {
            ...(object(previous) ? previous : {}),
            capabilities: {
              ...(object(previous?.capabilities) ? previous.capabilities : {}),
              responses: change.entry,
            },
          };
        }
        const backups = path.join(options.home, 'backups');
        fs.mkdirSync(backups, { recursive: true });
        const stamp = at.replace(/[:.]/g, '-') + '-' + randomUUID();
        fs.copyFileSync(file, path.join(backups, `helper-registry-${stamp}.json`), fs.constants.COPYFILE_EXCL);
        atomicJson(file, registry, fs.statSync(file).mode & 0o777);
      } finally {
        fs.closeSync(lockFd);
        fs.unlinkSync(lock);
      }
      status.events.push(...changes.map(change => change.event));
      status.price_mismatches = [
        ...status.price_mismatches,
        ...changes.filter(change => change.mismatch).map(change => ({ model: change.model, at, corrected: true })),
      ];
    }
    status.catalog = catalogFromDocs(pricingPage, indexPage, registry, status.flagged);
    status.error = null;
    status.last_success_at = at;
    return saveModelStatus(options.home, status);
  } catch (error) {
    status.error = String((error as Error)?.message ?? error);
    status.events.push({ at, kind: 'failure', error: status.error });
    saveModelStatus(options.home, status);
    throw error;
  }
}

export function openAIModelSummary(home: string, root = defaultOpenAIHelperRoot(home)): string {
  const status = readOpenAIModelStatus(home);
  let lines: Record<string, string> = {};
  let fallback = false;
  try { lines = newestOpenAILines(readOpenAIRegistry(root)); }
  catch {
    fallback = true;
    lines = { sol: 'gpt-6.2-sol', terra: 'gpt-6.1-terra', luna: 'gpt-6-luna', astra: 'gpt-6.2-astra' };
  }
  return `OpenAI models${fallback ? ' (fallback; registry unreadable, not verified)' : ''}: ${['luna', 'terra', 'sol', 'astra'].map(line => `${line}=${lines[line] ?? 'unavailable'}`).join(', ')}; `
    + `${status.events.filter(event => event.kind === 'added').length} automatic additions; `
    + `last check ${status.last_attempt_at ?? 'never'}; `
    + (status.error ? `ERROR ${status.error}` : `${status.price_mismatches.length} corrected price mismatches; ${status.flagged.length} flagged`);
}

export function openAIModelVisibility(home: string, root = defaultOpenAIHelperRoot(home)): string[] {
  const status = readOpenAIModelStatus(home);
  let lines: Record<string, string> = {};
  let profiles: ProfileSeed[] = [];
  let registry: ObjectMap | undefined;
  try {
    registry = readOpenAIRegistry(root);
    lines = newestOpenAILines(registry);
    profiles = openAIProfileSeeds(registry);
  } catch { /* summary reports unavailable */ }
  const responsesModels = registry ? responsesRegistryModels(registry).map(r => r.model) : [];
  const supersededLines = responsesModels.flatMap(model => {
    const sup = supersededBy(model, responsesModels);
    return sup ? [`  SUPERSEDED: ${model} -> ${sup} (refused at submit)`] : [];
  });
  const nonTextCatalog = (status.catalog ?? []).filter(entry => !entry.routable && entry.modality !== 'text');
  const fallbackNonText: OpenAICatalogEntry[] = !status.catalog && registry
    ? Object.entries(registryModelMap(registry)).flatMap(([model, details]) => {
        if (!object(details) || !object(details.capabilities) || object(details.capabilities.responses)) return [];
        const cap = Object.keys(details.capabilities)[0];
        if (!cap) return [];
        const spec = details.capabilities[cap];
        const rates = object(spec) && object(spec.tiers) && object(spec.tiers.default)
          ? Object.fromEntries(Object.entries(spec.tiers.default).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, `$${v}`]))
          : {};
        return [{ model, modality: capabilityModality(cap), routable: false, pricing: rates, source: 'helper-registry' }];
      })
    : [];
  const catalogLines = [...nonTextCatalog, ...fallbackNonText].map(entry => {
    const prices = Object.entries(entry.pricing).map(([k, v]) => `${k}=${v}`).join(', ');
    return `  CATALOG [not-routable] ${entry.model} (${entry.modality}): ${prices || '-'}${entry.superseded_by ? ` [superseded by ${entry.superseded_by}]` : ''}`;
  });
  return [
    openAIModelSummary(home, root),
    ...['luna', 'terra', 'sol', 'astra'].map(line => {
      const automatic = profiles.filter(seed => openAIProfileLine(seed.intent, seed.eff) === line)
        .map(seed => `${seed.intent}/${seed.eff}`);
      return `  ${line}: ${lines[line] ?? 'unavailable'}; automatic profile seeds: ${automatic.join(', ') || '-'}`;
    }),
    ...supersededLines,
    ...catalogLines,
    ...status.events.filter(event => event.kind !== 'failure').map(event =>
      `  automatic registry ${event.kind}: ${event.at} ${event.model}; source ${(event.sources ?? []).join(', ')}`),
    ...status.price_mismatches.map(mismatch =>
      `  page/registry price mismatch: ${mismatch.at} ${mismatch.model}; ${mismatch.corrected ? 'corrected from official pages' : 'not corrected'}`),
    ...(status.skipped ?? []).map(row => `  SKIPPED: ${row.model}: ${row.reason}`),
    ...status.flagged.map(model => `  FLAGGED: ${model} absent from current indexed Responses pricing; registry entry retained`),
  ];
}

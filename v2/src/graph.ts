/**
 * Bounded, staleness-verified retrieval from Graphify's local, rebuildable project indexes.
 * Graphify runs locally with GRAPHIFY_BACKEND=none (no LLM calls) and every edge's source files
 * are checked against the canonical project root and manifest mtimes before returning.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deniedPath, inside, realDirectory, same, secretLike } from './context.ts';
import { fail } from './errors.ts';

export const GRAPH_LIMIT = 128 * 1024 * 1024;
export const MANIFEST_LIMIT = 4 * 1024 * 1024;
export const RECEIPT_LIMIT = 16 * 1024;
export const MAX_QUERY_CHARS = 240;
export const MAX_EDGES = 12;
const LOCK_STALE_MS = 15 * 60 * 1000;
const GRAPH_CACHE_MAX = 4;

const SAFE_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', 'PYTHONIOENCODING',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'GRAPHIFY_BIN',
];

const GRAPHIFY_OWN_ENTRIES = new Set([
  'graph.json', 'manifest.json', '.graphify_build_state.json',
  'GRAPH_REPORT.md', '.graphify_labels.json', '.graphify_cache',
  'graphify.log', 'cache',
]);

export interface GraphIdentity {
  graphSize: bigint;
  graphMtimeNs: bigint;
  manifestSize: bigint;
  manifestMtimeNs: bigint;
}

export interface GraphStatus {
  status: 'available' | 'missing' | 'invalid' | 'unavailable';
  graphDir: string;
  nodes?: number;
  edges?: number;
  reason?: string;
}

export interface GraphEndpoint {
  symbol: string;
  path: string;
  location?: string | number | null;
}

export interface GraphRelationship {
  from: GraphEndpoint;
  relation: string;
  to: GraphEndpoint;
  evidence: { path: string; location?: string | number | null };
  confidence: string;
}

export interface GraphQueryResult {
  status: 'available' | 'partially-stale' | 'missing' | 'invalid' | 'unavailable' | 'updating';
  graphDir: string;
  reason?: string;
  relationships: GraphRelationship[];
}

interface RawGraphNode {
  id: string;
  label: string;
  source_file?: string;
  source_location?: string | number | null;
}

interface RawGraphEdge {
  source: string;
  target: string;
  relation: string;
  source_file?: string;
  source_location?: string | number | null;
  confidence?: string;
}

interface LoadedGraphData {
  nodes: RawGraphNode[];
  links: RawGraphEdge[];
  manifest: Record<string, { mtime?: number }>;
}

const graphCache = new Map<string, LoadedGraphData>();

function identityKey(graphDir: string, id: GraphIdentity): string {
  return `${same(graphDir)}\0${id.graphSize}\0${id.graphMtimeNs}\0${id.manifestSize}\0${id.manifestMtimeNs}`;
}

function sameIdentity(a: GraphIdentity, b: GraphIdentity): boolean {
  return a.graphSize === b.graphSize
    && a.graphMtimeNs === b.graphMtimeNs
    && a.manifestSize === b.manifestSize
    && a.manifestMtimeNs === b.manifestMtimeNs;
}

function assertRegularFile(file: string, limit: number): { stat: fs.BigIntStats; raw: string } {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw Object.assign(new Error(`missing ${path.basename(file)}`), { graphState: 'missing' });
    throw error;
  }
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    throw Object.assign(new Error(`${path.basename(file)} must be a regular non-symlink file`), { graphState: 'invalid' });
  }
  const stat = fs.statSync(file, { bigint: true });
  if (stat.size > BigInt(limit)) {
    throw Object.assign(new Error(`${path.basename(file)} exceeds size limit`), { graphState: 'invalid' });
  }
  return { stat, raw: fs.readFileSync(file, 'utf8') };
}

/** Extract a top-level integer (or digit-string) JSON property without matching nested objects or string contents. */
function extractTopLevelBigInt(raw: string, field: string): bigint | null {
  let i = 0;
  const skipWs = () => { while (i < raw.length && /\s/.test(raw[i])) i++; };
  const skipString = (): string | null => {
    if (raw[i] !== '"') return null;
    const start = i++;
    while (i < raw.length) {
      if (raw[i] === '\\') { i += 2; continue; }
      if (raw[i] === '"') { i++; return JSON.parse(raw.slice(start, i)) as string; }
      i++;
    }
    return null;
  };
  const skipValue = (): void => {
    skipWs();
    const ch = raw[i];
    if (ch === '"') { skipString(); return; }
    if (ch === '{' || ch === '[') {
      const open = ch, close = ch === '{' ? '}' : ']';
      let depth = 0;
      while (i < raw.length) {
        if (raw[i] === '"') { skipString(); continue; }
        if (raw[i] === open) depth++;
        else if (raw[i] === close && --depth === 0) { i++; return; }
        i++;
      }
      return;
    }
    while (i < raw.length && !/[\s,}\]]/.test(raw[i])) i++;
  };

  skipWs();
  if (raw[i] !== '{') return null;
  i++;
  while (i < raw.length) {
    skipWs();
    if (raw[i] === '}') return null;
    if (raw[i] === ',') { i++; continue; }
    const key = skipString();
    if (key === null) return null;
    skipWs();
    if (raw[i] !== ':') return null;
    i++;
    skipWs();
    if (key === field) {
      if (raw[i] === '"') {
        const s = skipString();
        return s !== null && /^\d+$/.test(s) ? BigInt(s) : null;
      }
      const start = i;
      while (i < raw.length && /\d/.test(raw[i])) i++;
      const numText = raw.slice(start, i);
      return numText && (i >= raw.length || /[\s,}]/.test(raw[i])) ? BigInt(numText) : null;
    }
    skipValue();
  }
  return null;
}

export function resolveGraphDir(home: string, projectRoot: string): string {
  const canonicalRoot = realDirectory(projectRoot) ?? path.resolve(projectRoot);
  const canonicalHome = realDirectory(home) ?? path.resolve(home);
  const mapFile = path.join(home, 'graphs.json');
  if (fs.existsSync(mapFile)) {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    } catch {
      return fail('GRAPHS_CONFIG_INVALID', 400, `${mapFile} is not valid JSON`);
    }
    const projects = (data as { projects?: unknown })?.projects;
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      for (const [key, mapped] of Object.entries(projects as Record<string, unknown>)) {
        const resolvedKey = realDirectory(key) ?? path.resolve(key);
        if (same(resolvedKey) !== same(canonicalRoot)) continue;
        if (typeof mapped !== 'string' || !path.isAbsolute(mapped)) {
          return fail('GRAPHS_CONFIG_INVALID', 400, `graph path for ${key} must be an absolute path`);
        }
        const resolvedMapped = path.resolve(mapped);
        if (inside(same(canonicalRoot), same(resolvedMapped)) || inside(same(resolvedMapped), same(canonicalRoot))) {
          return fail('GRAPHS_CONFIG_INVALID', 400, `graph path for ${key} must not overlap the project root`);
        }
        if (inside(same(resolvedMapped), same(canonicalHome))) {
          return fail('GRAPHS_CONFIG_INVALID', 400, `graph path for ${key} must not equal or enclose Agent Commons home`);
        }
        try {
          if (fs.lstatSync(resolvedMapped).isSymbolicLink()) {
            return fail('GRAPHS_CONFIG_INVALID', 400, `graph path for ${key} must not be a symlink`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
        return resolvedMapped;
      }
    }
  }
  const digest = createHash('sha256').update(same(canonicalRoot)).digest('hex').slice(0, 16);
  return path.join(home, 'graphs', digest);
}

export function graphIdentity(graphDir: string): GraphIdentity {
  let dirLstat: fs.Stats;
  try {
    dirLstat = fs.lstatSync(graphDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw Object.assign(new Error('graph directory missing'), { graphState: 'missing' });
    throw error;
  }
  if (dirLstat.isSymbolicLink() || !dirLstat.isDirectory()) {
    throw Object.assign(new Error('graph directory must not be a symlink'), { graphState: 'invalid' });
  }
  const graphFile = path.join(graphDir, 'graph.json');
  const manifestFile = path.join(graphDir, 'manifest.json');
  const receiptFile = path.join(graphDir, '.graphify_build_state.json');

  const graphLstat = fs.lstatSync(graphFile, { throwIfNoEntry: false });
  if (!graphLstat) throw Object.assign(new Error('missing graph.json'), { graphState: 'missing' });
  if (graphLstat.isSymbolicLink() || !graphLstat.isFile()) {
    throw Object.assign(new Error('graph.json must be a regular non-symlink file'), { graphState: 'invalid' });
  }
  const graphStat = fs.statSync(graphFile, { bigint: true });
  if (graphStat.size > BigInt(GRAPH_LIMIT)) {
    throw Object.assign(new Error('graph.json exceeds size limit'), { graphState: 'invalid' });
  }

  const manifestLstat = fs.lstatSync(manifestFile, { throwIfNoEntry: false });
  if (!manifestLstat) throw Object.assign(new Error('missing manifest.json'), { graphState: 'missing' });
  if (manifestLstat.isSymbolicLink() || !manifestLstat.isFile()) {
    throw Object.assign(new Error('manifest.json must be a regular non-symlink file'), { graphState: 'invalid' });
  }
  const manifestStat = fs.statSync(manifestFile, { bigint: true });
  if (manifestStat.size > BigInt(MANIFEST_LIMIT)) {
    throw Object.assign(new Error('manifest.json exceeds size limit'), { graphState: 'invalid' });
  }

  const { raw: receiptRaw } = assertRegularFile(receiptFile, RECEIPT_LIMIT);
  let parsedReceipt: unknown;
  try {
    parsedReceipt = JSON.parse(receiptRaw);
  } catch {
    throw Object.assign(new Error('invalid .graphify_build_state.json'), { graphState: 'invalid' });
  }
  if (!parsedReceipt || typeof parsedReceipt !== 'object' || Array.isArray(parsedReceipt)) {
    throw Object.assign(new Error('invalid .graphify_build_state.json object'), { graphState: 'invalid' });
  }
  if (!Object.hasOwn(parsedReceipt, 'graph_size') || !Object.hasOwn(parsedReceipt, 'graph_mtime_ns')) {
    throw Object.assign(new Error('build receipt missing graph_size or graph_mtime_ns'), { graphState: 'invalid' });
  }

  const receiptSize = extractTopLevelBigInt(receiptRaw, 'graph_size');
  const receiptMtimeNs = extractTopLevelBigInt(receiptRaw, 'graph_mtime_ns');
  if (receiptSize === null || receiptMtimeNs === null) {
    throw Object.assign(new Error('build receipt has invalid graph_size or graph_mtime_ns'), { graphState: 'invalid' });
  }
  if (receiptSize !== graphStat.size || receiptMtimeNs !== graphStat.mtimeNs) {
    throw Object.assign(new Error('graph differs from published build receipt'), { graphState: 'invalid' });
  }

  return {
    graphSize: graphStat.size,
    graphMtimeNs: graphStat.mtimeNs,
    manifestSize: manifestStat.size,
    manifestMtimeNs: manifestStat.mtimeNs,
  };
}

function loadGraphData(graphDir: string, identity?: GraphIdentity): LoadedGraphData {
  const key = identity ? identityKey(graphDir, identity) : undefined;
  if (key && graphCache.has(key)) {
    const cached = graphCache.get(key)!;
    graphCache.delete(key);
    graphCache.set(key, cached);
    return cached;
  }

  const { raw: graphRaw } = assertRegularFile(path.join(graphDir, 'graph.json'), GRAPH_LIMIT);
  const { raw: manifestRaw } = assertRegularFile(path.join(graphDir, 'manifest.json'), MANIFEST_LIMIT);
  const graph = JSON.parse(graphRaw) as { nodes?: unknown; links?: unknown };
  const manifest = JSON.parse(manifestRaw) as unknown;
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    throw Object.assign(new Error('graph.json must contain nodes and links arrays'), { graphState: 'invalid' });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw Object.assign(new Error('manifest.json must be a JSON object'), { graphState: 'invalid' });
  }
  const loaded: LoadedGraphData = {
    nodes: graph.nodes as RawGraphNode[],
    links: graph.links as RawGraphEdge[],
    manifest: manifest as Record<string, { mtime?: number }>,
  };
  if (key) {
    if (graphCache.size >= GRAPH_CACHE_MAX) {
      const oldest = graphCache.keys().next().value;
      if (oldest !== undefined) graphCache.delete(oldest);
    }
    graphCache.set(key, loaded);
  }
  return loaded;
}

export function graphStatus(projectRoot: string, graphDir: string): GraphStatus {
  const canonicalRoot = realDirectory(projectRoot);
  if (!canonicalRoot) {
    return { status: 'unavailable', graphDir, reason: 'project root is not an existing directory' };
  }
  try {
    const id = graphIdentity(graphDir);
    const { nodes, links } = loadGraphData(graphDir, id);
    return { status: 'available', graphDir, nodes: nodes.length, edges: links.length };
  } catch (error) {
    const state = (error as { graphState?: string }).graphState;
    return {
      status: state === 'missing' ? 'missing' : 'invalid',
      graphDir,
      reason: (error as Error).message,
    };
  }
}

export function queryGraph(
  projectRoot: string,
  graphDir: string,
  topic: string,
  deny: string[] = [],
): GraphQueryResult {
  const trimmed = topic.trim();
  if (!trimmed || trimmed.length > MAX_QUERY_CHARS) {
    fail('CTX_BAD_REF', 400, `graph query must be 1-${MAX_QUERY_CHARS} characters`);
  }
  const canonicalRoot = realDirectory(projectRoot);
  if (!canonicalRoot) {
    return { status: 'unavailable', graphDir, reason: 'project root is not an existing directory', relationships: [] };
  }

  let before: GraphIdentity;
  let data: LoadedGraphData;
  let after: GraphIdentity;
  try {
    before = graphIdentity(graphDir);
    data = loadGraphData(graphDir, before);
    after = graphIdentity(graphDir);
  } catch (error) {
    const state = (error as { graphState?: string }).graphState;
    return {
      status: state === 'missing' ? 'missing' : 'invalid',
      graphDir,
      reason: (error as Error).message,
      relationships: [],
    };
  }
  if (!sameIdentity(before, after)) {
    return { status: 'updating', graphDir, relationships: [] };
  }

  const terms = new Set(trimmed.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (!terms.size) {
    return { status: 'available', graphDir, relationships: [] };
  }

  const nodes = new Map<string, RawGraphNode>();
  const scores = new Map<string, { exact: number; matches: number }>();
  const lowerTopic = trimmed.toLowerCase();

  for (const node of data.nodes) {
    if (!node || typeof node.id !== 'string' || typeof node.label !== 'string') continue;
    nodes.set(node.id, node);
    const label = node.label.toLowerCase();
    const labelTerms = new Set(label.match(/[a-z0-9]+/g) ?? []);
    let matches = 0;
    for (const term of terms) {
      if (labelTerms.has(term)) matches++;
    }
    if (matches > 0) {
      scores.set(node.id, { exact: label.replace(/\(\)$/, '') === lowerTopic ? 1 : 0, matches });
    }
  }

  const closest = new Set(
    [...scores.entries()]
      .sort((a, b) => b[1].exact - a[1].exact || b[1].matches - a[1].matches || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, 10)
      .map(([id]) => id),
  );
  if (!closest.size) {
    return { status: 'available', graphDir, relationships: [] };
  }

  const rootBase = path.basename(canonicalRoot);
  const manifestEntry = (name: string): { mtime?: number } | undefined => {
    const posixName = name.replaceAll('\\', '/');
    return data.manifest[name] ?? data.manifest[posixName] ?? data.manifest[`${rootBase}/${posixName}`];
  };

  const verifiedCache = new Map<string, boolean>();
  const verifySource = (row: { source_file?: unknown; source_location?: string | number | null }): { path: string; location?: string | number | null } | null => {
    if (typeof row.source_file !== 'string' || !row.source_file) return null;
    const rel = row.source_file;
    if (!verifiedCache.has(rel)) {
      let ok = false;
      try {
        const parts = rel.split(/[\\/]/);
        if (!path.isAbsolute(rel) && !/^[A-Za-z]:/.test(rel) && !parts.includes('..') && !parts.some(secretLike)) {
          const full = path.resolve(canonicalRoot, rel);
          if (inside(same(canonicalRoot), same(full))) {
            const lstat = fs.lstatSync(full);
            if (!lstat.isSymbolicLink()) {
              const real = fs.realpathSync(full);
              if (inside(same(canonicalRoot), same(real))
                && !path.relative(canonicalRoot, real).split(/[\\/]/).some(secretLike)
                && !deniedPath(full, real, deny)) {
                const stat = fs.statSync(real);
                const entry = manifestEntry(rel);
                if (stat.isFile() && typeof entry?.mtime === 'number' && Math.abs(stat.mtimeMs / 1000 - entry.mtime) <= 0.002) {
                  ok = true;
                }
              }
            }
          }
        }
      } catch {
        ok = false;
      }
      verifiedCache.set(rel, ok);
    }
    if (!verifiedCache.get(rel)) return null;
    return {
      path: rel.replaceAll('\\', '/'),
      ...(row.source_location !== undefined && row.source_location !== null ? { location: row.source_location } : {}),
    };
  };

  let stale = false;
  const ranked: Array<{ exact: number; matches: number; nonStructural: number; rel: GraphRelationship }> = [];

  for (const edge of data.links) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string' || typeof edge.relation !== 'string') continue;
    if (!closest.has(edge.source) && !closest.has(edge.target)) continue;
    const leftNode = nodes.get(edge.source);
    const rightNode = nodes.get(edge.target);
    if (!leftNode || !rightNode) continue;

    const origin = verifySource(edge);
    const left = verifySource(leftNode);
    const right = verifySource(rightNode);
    if (!origin || !left || !right) {
      for (const [row, ref] of [[edge, origin], [leftNode, left], [rightNode, right]] as const) {
        if (!ref && typeof row.source_file === 'string' && manifestEntry(row.source_file)) {
          stale = true;
        }
      }
      continue;
    }

    const sLeft = scores.get(edge.source) ?? { exact: 0, matches: 0 };
    const sRight = scores.get(edge.target) ?? { exact: 0, matches: 0 };
    const exact = Math.max(sLeft.exact, sRight.exact);
    const matches = sLeft.exact > sRight.exact ? sLeft.matches : sRight.exact > sLeft.exact ? sRight.matches : Math.max(sLeft.matches, sRight.matches);
    const nonStructural = edge.relation !== 'contains' && edge.relation !== 'defines' ? 1 : 0;

    ranked.push({
      exact,
      matches,
      nonStructural,
      rel: {
        from: { symbol: leftNode.label.slice(0, 200), ...left },
        relation: edge.relation,
        to: { symbol: rightNode.label.slice(0, 200), ...right },
        evidence: origin,
        confidence: typeof edge.confidence === 'string' ? edge.confidence : 'unknown',
      },
    });
  }

  ranked.sort((a, b) => b.exact - a.exact || b.matches - a.matches || b.nonStructural - a.nonStructural);
  return {
    status: stale ? 'partially-stale' : 'available',
    graphDir,
    relationships: ranked.slice(0, MAX_EDGES).map(item => item.rel),
  };
}

export function formatGraphContext(result: GraphQueryResult, topic: string, maxChars = 4000): string {
  const header = `graph status=${result.status} query=${JSON.stringify(topic.trim())} edges=${result.relationships.length}`
    + (result.reason ? ` reason=${JSON.stringify(result.reason)}` : '');
  const lines = [header];
  let used = header.length;
  for (const rel of result.relationships) {
    const loc = (ep: { path: string; location?: string | number | null }) =>
      ep.location !== undefined && ep.location !== null && ep.location !== '' ? `${ep.path}:${ep.location}` : ep.path;
    const line = `${rel.from.symbol} (${loc(rel.from)}) --[${rel.relation}]--> ${rel.to.symbol} (${loc(rel.to)}) [conf=${rel.confidence}]`;
    if (used + 1 + line.length > maxChars) break;
    lines.push(line);
    used += 1 + line.length;
  }
  return lines.join('\n');
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

function acquireGraphLock(lockPath: string): number {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, started_at: Date.now() }));
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      if (attempt === 0) {
        let stale = false;
        try {
          const stat = fs.statSync(lockPath);
          const age = Date.now() - stat.mtimeMs;
          const meta = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number; started_at?: number };
          const pidDead = typeof meta.pid === 'number' && !isPidAlive(meta.pid);
          const timedOut = typeof meta.started_at === 'number'
            ? Date.now() - meta.started_at > LOCK_STALE_MS
            : age > LOCK_STALE_MS;
          if (pidDead || timedOut) stale = true;
        } catch {
          // Empty/corrupt lock older than 5 seconds can be reclaimed.
          try {
            if (Date.now() - fs.statSync(lockPath).mtimeMs > 5000) stale = true;
          } catch { stale = true; }
        }
        if (stale) {
          try { fs.unlinkSync(lockPath); } catch { /* raced with another cleaner */ }
          continue;
        }
      }
      fail('GRAPH_BUSY', 409, `another graph refresh is holding ${lockPath}`);
    }
  }
  return fail('GRAPH_BUSY', 409, `another graph refresh is holding ${lockPath}`);
}

/** Resolve graphify executable outside the project root so libuv never executes a repo-planted binary on Windows. */
export function resolveGraphifyExecutable(canonicalRoot: string): string {
  const configured = process.env.GRAPHIFY_BIN?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    if (inside(same(canonicalRoot), same(resolved))) {
      return fail('GRAPHIFY_UNSAFE_PATH', 400, 'GRAPHIFY_BIN must not live inside the project root');
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return fail('GRAPHIFY_NOT_FOUND', 404, `GRAPHIFY_BIN not found: ${resolved}`);
    }
    return resolved;
  }
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  const names = process.platform === 'win32' ? ['graphify.exe', 'graphify'] : ['graphify'];
  for (const rawDir of pathEnv.split(path.delimiter)) {
    if (!rawDir) continue;
    const dir = path.resolve(rawDir);
    if (inside(same(canonicalRoot), same(dir))) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* try next */ }
    }
  }
  return fail('GRAPHIFY_NOT_FOUND', 404, 'graphify executable not found on PATH outside the project root');
}

function minimalGraphifyEnv(outputDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GRAPHIFY_OUT = outputDir;
  env.GRAPHIFY_BACKEND = 'none';
  env.GRAPHIFY_QUERY_LOG_DISABLE = '1';
  env.GRAPHIFY_NO_TIPS = '1';
  env.GRAPHIFY_FOLLOW_SYMLINKS = '0';
  env.GRAPHIFY_MAX_WORKERS = '2';
  env.PYTHONUNBUFFERED = '1';
  return env;
}

function isPureGraphifyDirectory(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir);
    return entries.every(name => GRAPHIFY_OWN_ENTRIES.has(name) || name.startsWith('.graphify_'));
  } catch {
    return false;
  }
}

export function refreshGraph(
  projectRoot: string,
  graphDir: string,
  options: { force?: boolean; spawnImpl?: typeof spawnSync } = {},
): GraphStatus {
  const canonicalRoot = realDirectory(projectRoot) ?? fail('CTX_NOT_FOUND', 404, 'project root is not an existing directory');
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const executable = options.spawnImpl ? 'graphify' : resolveGraphifyExecutable(canonicalRoot);
  const parent = path.dirname(graphDir);
  fs.mkdirSync(parent, { recursive: true });
  const lockPath = path.join(parent, `${path.basename(graphDir)}.lock`);
  const fd = acquireGraphLock(lockPath);

  const runUpdate = (outputDir: string) => {
    fs.mkdirSync(outputDir, { recursive: true });
    const args = ['update', canonicalRoot, '--no-cluster'];
    if (options.force) args.push('--force');
    const res = spawnImpl(executable, args, {
      cwd: canonicalRoot,
      env: minimalGraphifyEnv(outputDir),
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 900_000,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`graphify exited ${res.status}: ${(res.stderr || res.stdout || '').trim().slice(0, 400)}`);
    }
  };

  try {
    const current = graphStatus(canonicalRoot, graphDir);
    if (current.status === 'available' || current.status === 'missing') {
      runUpdate(graphDir);
      return graphStatus(canonicalRoot, graphDir);
    }

    if (!isPureGraphifyDirectory(graphDir)) {
      return fail('GRAPH_REPAIR_REFUSED', 400, `${graphDir} contains non-Graphify files; repair refused`);
    }

    // Existing graph is invalid/corrupt: rebuild into a fresh staged sibling and swap atomically.
    const stageRoot = fs.mkdtempSync(path.join(parent, `${path.basename(graphDir)}-repair-`));
    const candidate = path.join(stageRoot, 'graph');
    const backup = path.join(parent, `${path.basename(graphDir)}.corrupt-${Date.now()}`);
    try {
      runUpdate(candidate);
      graphIdentity(candidate);
      fs.renameSync(graphDir, backup);
      try {
        fs.renameSync(candidate, graphDir);
      } catch (error) {
        try { fs.renameSync(backup, graphDir); } catch { /* best-effort restore */ }
        throw error;
      }
      try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* ignore cleanup failure */ }
    } finally {
      try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch { /* ignore cleanup failure */ }
    }
    return graphStatus(canonicalRoot, graphDir);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

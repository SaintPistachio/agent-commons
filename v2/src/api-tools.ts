/**
 * Tools for openai-api jobs. The model calls them natively (Responses function tools, relayed by the central helper);
 * Agent Commons runs each call here: the built-in read-only `project` set in-process, or an approved MCP tool set
 * through one stdio server started for the job's lifetime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { checkSecrets, deniedPath, inside, readContextFile, same, secretLike } from './context.ts';
import { CommonsError } from './errors.ts';
import { killTree } from './adapters/shared.ts';
import type { JobToolset } from './tool-hub.ts';

/** Each tool result the model sees is cut to this many characters. */
export const TOOL_RESULT_CHARS = 16000;
/** One MCP tool call may take this long (the Codex route uses the same limit). */
export const TOOL_TIMEOUT_MS = 240000;

type Schema = Record<string, any>;
/** A strict function tool for the Responses API, plus the original schema (to drop optional nulls before a call). */
export interface FunctionTool { type: 'function'; name: string; description: string; parameters: Schema; strict: true }
export interface ToolHost {
  tools: FunctionTool[];
  /** Tools the set grants that could not be offered, with why. */
  skipped: string[];
  /** Child process ID when backed by a stdio MCP server, for crash cleanup. */
  pid?: number | null;
  /** Runs one call; never throws: errors come back as text for the model. */
  call(name: string, argumentsJson: string): Promise<string>;
  close(): void;
}

// ---- Strict schema conversion ------------------------------------------------------------------------------------

const KEEP = new Set(['type', 'properties', 'required', 'items', 'enum', 'anyOf', 'description', 'title']);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

class NotStrict extends Error {}
const nullable = (s: Schema): Schema => {
  if (s.anyOf) return s.anyOf.some((x: Schema) => x.type === 'null') ? s : { ...s, anyOf: [...s.anyOf, { type: 'null' }] };
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const out: Schema = { ...s };
  if (types.length && !types.includes('null')) out.type = [...types, 'null'];
  if (out.enum && !out.enum.includes(null)) out.enum = [...out.enum, null];
  return out;
};

/**
 * The helper's strict subset of JSON Schema: every object closed with every property required; optional properties
 * become nullable. Keywords the subset lacks (default, minimum, format ...) are dropped; the server still checks them.
 */
function strictNode(s: unknown, depth = 0): Schema {
  if (depth > 24 || !s || typeof s !== 'object' || Array.isArray(s)) throw new NotStrict('schema node is not an object');
  const src = s as Schema;
  if (src.$ref || src.allOf || src.not || src.if || src.patternProperties) throw new NotStrict('uses $ref, allOf, not, if or patternProperties');
  const out: Schema = {};
  for (const [k, v] of Object.entries(src)) if (KEEP.has(k)) out[k] = v;
  if (src.oneOf) out.anyOf = src.oneOf;
  if (src.const !== undefined && out.enum === undefined) out.enum = [src.const];
  if (out.description !== undefined && typeof out.description !== 'string') delete out.description;
  if (out.title !== undefined && typeof out.title !== 'string') delete out.title;
  if (out.anyOf) {
    if (!Array.isArray(out.anyOf) || !out.anyOf.length) throw new NotStrict('empty anyOf');
    out.anyOf = out.anyOf.map((x: unknown) => strictNode(x, depth + 1));
  }
  const types: string[] = Array.isArray(out.type) ? out.type : out.type !== undefined ? [out.type] : [];
  if (types.some(t => !TYPES.has(t))) throw new NotStrict(`unsupported type ${JSON.stringify(out.type)}`);
  if (!types.length && !out.anyOf && !out.enum) throw new NotStrict('a node without type, enum or anyOf');
  if (out.enum !== undefined && (!Array.isArray(out.enum) || !out.enum.length)) throw new NotStrict('empty enum');
  if (types.includes('object') || (out.properties && !types.length)) {
    const extra = src.additionalProperties;
    if (extra !== undefined && extra !== false && !(typeof extra === 'object' && !Object.keys(extra).length && src.properties))
      throw new NotStrict('an open map (additionalProperties)');
    const props = src.properties && typeof src.properties === 'object' ? src.properties as Schema : {};
    const required = new Set(Array.isArray(src.required) ? src.required : []);
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => {
      const node = strictNode(v, depth + 1);
      return [k, required.has(k) ? node : nullable(node)];
    }));
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
    if (!types.length) out.type = 'object';
  }
  if (types.includes('array')) {
    if (src.items === undefined || Array.isArray(src.items)) throw new NotStrict('an array without a single items schema');
    out.items = strictNode(src.items, depth + 1);
  }
  return out;
}

/** The strict parameters for an MCP tool, or why it cannot be offered. */
export function strictParameters(schema: unknown): { parameters: Schema } | { error: string } {
  try {
    const src = (schema && typeof schema === 'object' ? schema : { type: 'object' }) as Schema;
    if (src.type !== undefined && src.type !== 'object') return { error: 'input schema is not an object' };
    return { parameters: strictNode({ ...src, type: 'object', properties: src.properties ?? {} }) };
  } catch (error) {
    return { error: error instanceof NotStrict ? error.message : 'schema could not be read' };
  }
}

/** Drops nulls the model sent for properties the original schema made optional (they meant "leave it out"). */
export function dropOptionalNulls(value: unknown, schema: unknown): unknown {
  const s = (schema && typeof schema === 'object' ? schema : {}) as Schema;
  if (Array.isArray(value)) return value.map(v => dropOptionalNulls(v, s.items));
  if (!value || typeof value !== 'object') return value;
  const required = new Set(Array.isArray(s.required) ? s.required : []), props = (s.properties ?? {}) as Schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null && !required.has(k)) continue;
    out[k] = dropOptionalNulls(v, props[k]);
  }
  return out;
}

export function truncate(text: string, limit = TOOL_RESULT_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[${text.length - limit} more characters cut; ask for a narrower range]`;
}

const parseArgs = (json: string): Record<string, unknown> | string => {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return 'error: the arguments are not valid JSON'; }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : 'error: the arguments must be a JSON object';
};

// ---- Built-in project tool set -----------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target']);
const MAX_LIST = 500, MAX_GREP_FILES = 2000, MAX_GREP_MATCHES = 200, MAX_GREP_BYTES = 1024 * 1024;

const PROJECT_TOOLS: FunctionTool[] = [
  { type: 'function', name: 'read_file', strict: true,
    description: 'Read a text file in the job folder. Lines are numbered. Give a line range for large files.',
    parameters: { type: 'object', additionalProperties: false, required: ['path', 'start_line', 'end_line'], properties: {
      path: { type: 'string', description: 'Path relative to the job folder' },
      start_line: { type: ['integer', 'null'], description: 'First line (1-based), or null for the start' },
      end_line: { type: ['integer', 'null'], description: 'Last line (inclusive), or null for the end' } } } },
  { type: 'function', name: 'grep', strict: true,
    description: 'Find lines containing a literal text (case-insensitive) in one file or in every text file under a folder.',
    parameters: { type: 'object', additionalProperties: false, required: ['path', 'text', 'context_lines'], properties: {
      path: { type: 'string', description: 'File or folder relative to the job folder; "." for all of it' },
      text: { type: 'string', description: 'Literal text to find' },
      context_lines: { type: ['integer', 'null'], description: 'Lines of context around each match (0-10), or null for 0' } } } },
  { type: 'function', name: 'list_dir', strict: true,
    description: 'List a folder in the job folder: subfolders end with /, files show their size in bytes.',
    parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', description: 'Folder relative to the job folder; "." for the job folder' } } } },
];

/** Resolves a model-given path inside root with the ctx= rules (no escapes, secrets or AC data). */
function resolveInside(root: string, given: string, deny: string[]): string {
  const target = given.trim() || '.';
  if (path.isAbsolute(target) || /^[A-Za-z]:/.test(target)) throw new Error('give a path relative to the job folder');
  const full = path.resolve(root, target);
  if (!inside(root, full) && path.resolve(root) !== full) throw new Error('that path is outside the job folder');
  const rel = path.relative(root, full);
  if (rel && rel.split(/[\\/]/).some(secretLike)) throw new Error('that path looks like a secret or credential file');
  if (!fs.existsSync(full)) throw new Error('not found');
  const real = fs.realpathSync(full), realRoot = fs.realpathSync(root);
  if (real !== realRoot && !inside(same(realRoot), same(real))) throw new Error('that path leads outside the job folder');
  const realRel = path.relative(realRoot, real);
  if (realRel && realRel.split(/[\\/]/).some(secretLike)) throw new Error('that path looks like a secret or credential file');
  if (deniedPath(full, real, deny)) throw new Error('that path is inside the Agent Commons data folder');
  return full;
}

const message = (error: unknown) => error instanceof CommonsError ? error.message : String((error as Error)?.message ?? error);

export function projectTools(root: string, deny: string[]): ToolHost {
  const rel = (full: string) => path.relative(root, full).replaceAll('\\', '/') || '.';
  const run: Record<string, (args: Record<string, unknown>) => string> = {
    read_file(args) {
      const target = String(args.path ?? '');
      const text = readContextFile(`read_file:${target}`, target, root, deny);
      const lines = text.split(/\r?\n/);
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const from = Number.isInteger(args.start_line) ? Math.max(1, args.start_line as number) : 1;
      const to = Number.isInteger(args.end_line) ? Math.min(lines.length, args.end_line as number) : lines.length;
      if (from > lines.length) return `${target} has ${lines.length} lines`;
      const body = lines.slice(from - 1, to).map((line, i) => `${from + i}|${line}`).join('\n');
      checkSecrets(`read_file:${target}`, body);
      return `${target} lines ${from}-${to} of ${lines.length}\n${body}`;
    },
    grep(args) {
      const needle = String(args.text ?? '').toLowerCase();
      if (!needle) return 'error: give the text to find';
      const radius = Number.isInteger(args.context_lines) ? Math.min(10, Math.max(0, args.context_lines as number)) : 0;
      const start = resolveInside(root, String(args.path ?? '.'), deny);
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (files.length >= MAX_GREP_FILES) return;
          if (secretLike(entry.name) || SKIP_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (deniedPath(full, full, deny)) continue;
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) files.push(full);
        }
      };
      if (fs.statSync(start).isDirectory()) walk(start); else files.push(start);
      const out: string[] = [];
      let matches = 0, withheld = 0;
      for (const file of files) {
        if (matches >= MAX_GREP_MATCHES) break;
        let bytes: Buffer;
        try { if (fs.statSync(file).size > MAX_GREP_BYTES) continue; bytes = fs.readFileSync(file); } catch { continue; }
        if (bytes.subarray(0, 8192).includes(0)) continue;
        const lines = bytes.toString('utf8').split(/\r?\n/);
        const hits = lines.flatMap((line, i) => line.toLowerCase().includes(needle) ? [i] : []);
        if (!hits.length) continue;
        const shown = new Set<number>();
        for (const i of hits.slice(0, MAX_GREP_MATCHES - matches)) for (let n = Math.max(0, i - radius); n <= Math.min(lines.length - 1, i + radius); n++) shown.add(n);
        matches += Math.min(hits.length, MAX_GREP_MATCHES - matches);
        const block = [...shown].sort((a, b) => a - b).map(n => `${rel(file)}:${n + 1}|${lines[n]}`).join('\n');
        try { checkSecrets(rel(file), block); out.push(block); } catch { withheld++; }
      }
      const notes = [matches >= MAX_GREP_MATCHES ? `(stopped at ${MAX_GREP_MATCHES} matches)` : '', files.length >= MAX_GREP_FILES ? `(searched the first ${MAX_GREP_FILES} files)` : '',
        withheld ? `(${withheld} file(s) withheld: credential-like text)` : ''].filter(Boolean);
      return (out.join('\n') || '(no matches)') + (notes.length ? '\n' + notes.join(' ') : '');
    },
    list_dir(args) {
      const dir = resolveInside(root, String(args.path ?? '.'), deny);
      if (!fs.statSync(dir).isDirectory()) return 'error: not a folder';
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !secretLike(e.name) && !deniedPath(path.join(dir, e.name), path.join(dir, e.name), deny))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const lines = entries.slice(0, MAX_LIST).map(e => e.isDirectory() ? `${e.name}/` : `${e.name} ${(() => { try { return fs.statSync(path.join(dir, e.name)).size; } catch { return '?'; } })()}`);
      return `${rel(dir)}/\n${lines.join('\n') || '(empty)'}${entries.length > MAX_LIST ? `\n(${entries.length - MAX_LIST} more not shown)` : ''}`;
    },
  };
  return {
    tools: PROJECT_TOOLS, skipped: [],
    async call(name, argumentsJson) {
      const fn = run[name];
      if (!fn) return `error: no tool named ${name}`;
      const args = parseArgs(argumentsJson);
      if (typeof args === 'string') return args;
      try { return truncate(fn(args)); } catch (error) { return `error: ${message(error)}`; }
    },
    close() { /* nothing to stop */ },
  };
}

// ---- MCP tool sets -----------------------------------------------------------------------------------------------

export interface McpOptions {
  /** Saved images (screenshots) go here, since the helper cannot carry them. */
  dir: string;
  /** stderr of the server, for the job's log. */
  log?: (line: string) => void;
  timeoutMs?: number;
  /** Registered right when the stdio transport is created so cancel/timeout/stop can kill startup hangs. */
  onClose?: (close: () => void) => void;
}

/** Starts the set's stdio server, lists its tools, and offers only the ones this job was granted. */
export async function mcpTools(set: JobToolset, options: McpOptions): Promise<ToolHost> {
  const spec = set.spec ?? (() => { throw new Error(`tool set ${set.name} has no server to start`); })();
  const env = spec.env && Object.keys(spec.env).length ? { ...getDefaultEnvironment(), ...spec.env } : undefined;
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, ...(spec.cwd ? { cwd: spec.cwd } : {}), ...(env ? { env } : {}), stderr: 'pipe' });
  const client = new Client({ name: 'agent-commons-api-job', version: '1.0.0' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const pid = transport.pid;
    void client.close().catch(() => {});
    // The server may have started its own children (the Blender wrapper does): end the whole tree.
    if (pid) killTree(pid);
  };
  options.onClose?.(close);
  if (closed) throw new Error('MCP server closed before startup');
  (transport.stderr as NodeJS.ReadableStream | null)?.on('data', chunk => options.log?.(String(chunk)));
  try {
    await client.connect(transport);
    if (closed) throw new Error('MCP server closed during connect');
    const listed = await client.listTools(undefined, { timeout: 60000 });
    if (closed) throw new Error('MCP server closed during listTools');
    const granted = new Set(set.tools), tools: FunctionTool[] = [], skipped: string[] = [], schemas = new Map<string, Schema>();
    for (const tool of listed.tools) {
      if (!granted.has(tool.name)) continue;
      const strict = strictParameters(tool.inputSchema);
      if ('error' in strict) { skipped.push(`${tool.name}: ${strict.error}`); continue; }
      schemas.set(tool.name, tool.inputSchema as Schema);
      tools.push({ type: 'function', name: tool.name, description: (tool.description ?? '').slice(0, 4000), parameters: strict.parameters, strict: true });
    }
    for (const name of set.tools) if (!listed.tools.some(t => t.name === name)) skipped.push(`${name}: the server does not offer it`);
    let images = 0;
    return {
      tools, skipped, pid: transport.pid ?? null, close,
      async call(name, argumentsJson) {
        if (!schemas.has(name)) return `error: no granted tool named ${name}`;
        const args = parseArgs(argumentsJson);
        if (typeof args === 'string') return args;
        try {
          const result = await client.callTool({ name, arguments: dropOptionalNulls(args, schemas.get(name)) as Record<string, unknown> }, undefined, { timeout: options.timeoutMs ?? TOOL_TIMEOUT_MS });
          const parts: string[] = [];
          for (const item of (result.content ?? []) as Array<Record<string, any>>) {
            if (item.type === 'text') parts.push(String(item.text ?? ''));
            else if (item.type === 'image' && typeof item.data === 'string') {
              const ext = /png/.test(item.mimeType) ? 'png' : /jpe?g/.test(item.mimeType) ? 'jpg' : 'bin', file = `tool-image-${++images}.${ext}`;
              try { fs.writeFileSync(path.join(options.dir, file), Buffer.from(item.data, 'base64')); } catch { /* the note still goes back */ }
              parts.push(`[image ${item.mimeType ?? ''} saved by Agent Commons as ${file} in the job folder; the API route cannot pass images to the model]`);
            } else parts.push(`[${item.type} content omitted]`);
          }
          if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
          return truncate((result.isError ? 'error: ' : '') + (parts.join('\n') || '(no output)'));
        } catch (error) { return `error: ${message(error).slice(0, 2000)}`; }
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

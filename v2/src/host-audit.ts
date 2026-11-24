/**
 * Read-only audit of Codex, Claude Code, and Antigravity local configurations:
 * duplicate MCP servers, name collisions, missing executables, drifted/missing
 * Agent Commons --connection paths, tool-hub conflicts, and credential markers.
 * Never mutates host files and never includes secret values or snippets in output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inside, same } from './context.ts';
import { hubStatus, loadManifest, manifestPath } from './tool-hub.ts';

export type AuditApp = 'codex' | 'claude' | 'antigravity';
export type AuditSeverity = 'high' | 'warn' | 'info';

export interface AuditFinding {
  severity: AuditSeverity;
  kind:
    | 'duplicate_mcp_server'
    | 'mcp_name_collision'
    | 'missing_executable'
    | 'missing_connection'
    | 'drifted_connection'
    | 'credential_marker'
    | 'tool_hub_conflict'
    | 'config_invalid';
  app: AuditApp | 'shared';
  file?: string;
  line?: number;
  server?: string;
  servers?: string[];
  rule?: string;
  detail: string;
}

export interface HostAuditReport {
  home: string;
  userHome: string;
  apps: AuditApp[];
  scannedFiles: string[];
  findings: AuditFinding[];
  clean: boolean;
}

export interface ParsedMcpServer {
  name: string;
  source: string;
  enabled: boolean;
  command?: string;
  args: string[];
  url?: string;
}

const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const DEFAULT_APPS: AuditApp[] = ['codex', 'claude', 'antigravity'];

const SECRET_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: 'api_sk_key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { rule: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { rule: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** Strip TOML comments (# ...) outside single/double quoted strings. */
function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"') {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '#') return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlString(raw: string): string | undefined {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  return undefined;
}

function parseTomlStringArray(raw: string): string[] | undefined {
  const s = raw.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return undefined;
  const inner = s.slice(1, -1);
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i])) i++;
    if (i >= inner.length) break;
    const ch = inner[i];
    if (ch === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < inner.length) {
        if (escaped) { escaped = false; j++; continue; }
        if (inner[j] === '\\') { escaped = true; j++; continue; }
        if (inner[j] === '"') break;
        j++;
      }
      if (j >= inner.length) return undefined;
      const val = parseTomlString(inner.slice(i, j + 1));
      if (val === undefined) return undefined;
      out.push(val);
      i = j + 1;
    } else if (ch === "'") {
      const j = inner.indexOf("'", i + 1);
      if (j < 0) return undefined;
      out.push(inner.slice(i + 1, j));
      i = j + 1;
    } else {
      return undefined;
    }
  }
  return out;
}

function bracketBalance(text: string): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"') {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
    }
  }
  return depth;
}

export function parseCodexMcpServers(toml: string, source = 'config.toml'): ParsedMcpServer[] {
  const servers = new Map<string, ParsedMcpServer>();
  let current: ParsedMcpServer | null = null;
  let inDirectServerTable = false;
  let inTopLevel = true;
  let multilineDelimiter: '"""' | "'''" | null = null;

  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (multilineDelimiter) {
      const endIdx = rawLine.indexOf(multilineDelimiter);
      if (endIdx >= 0) multilineDelimiter = null;
      continue;
    }

    const clean = stripTomlComment(rawLine).trim();
    if (!clean) continue;

    // Detect opening multiline triple-quoted strings (best-effort skip so inner lines aren't treated as headers).
    const tripleMatch = /(?:"""|''')/.exec(clean);
    if (tripleMatch) {
      const delim = tripleMatch[0] as '"""' | "'''";
      const second = clean.indexOf(delim, tripleMatch.index + 3);
      if (second < 0) multilineDelimiter = delim;
    }

    if (clean.startsWith('[[')) {
      inTopLevel = false;
      inDirectServerTable = false;
      current = null;
      continue;
    }

    if (clean.startsWith('[')) {
      inTopLevel = false;
      const serverMatch = /^\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]$/.exec(clean);
      if (serverMatch) {
        const name = serverMatch[1] ?? serverMatch[2] ?? serverMatch[3];
        current = servers.get(name) ?? { name, source, enabled: true, args: [] };
        servers.set(name, current);
        inDirectServerTable = true;
      } else {
        inDirectServerTable = false;
      }
      continue;
    }

    let targetServer: ParsedMcpServer | null = inDirectServerTable ? current : null;
    let key: string | undefined;
    let rawVal: string | undefined;

    if (inTopLevel) {
      const dottedMatch = /^mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\.\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(clean);
      if (dottedMatch) {
        const name = dottedMatch[1] ?? dottedMatch[2] ?? dottedMatch[3];
        targetServer = servers.get(name) ?? { name, source, enabled: true, args: [] };
        servers.set(name, targetServer);
        key = dottedMatch[4];
        rawVal = dottedMatch[5];
      }
    }

    if (!key) {
      if (!targetServer) continue;
      const kvMatch = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(clean);
      if (!kvMatch) continue;
      key = kvMatch[1];
      rawVal = kvMatch[2];
    }

    if (key === 'enabled') {
      const v = rawVal!.trim();
      if (v === 'false') targetServer!.enabled = false;
      else if (v === 'true') targetServer!.enabled = true;
    } else if (key === 'command') {
      const v = parseTomlString(rawVal!);
      if (v !== undefined) targetServer!.command = v;
    } else if (key === 'url') {
      const v = parseTomlString(rawVal!);
      if (v !== undefined) targetServer!.url = v;
    } else if (key === 'args') {
      let buf = rawVal!.trim();
      while (buf.startsWith('[') && bracketBalance(buf) > 0 && i + 1 < lines.length) {
        i++;
        buf += '\n' + stripTomlComment(lines[i]).trim();
      }
      const parsed = parseTomlStringArray(buf);
      if (parsed) targetServer!.args = parsed;
    }
  }

  return [...servers.values()];
}

type SafeReadResult =
  | { status: 'ok'; content: string }
  | { status: 'oversized'; size: number }
  | { status: 'absent' };

function readSafeFile(userHomeReal: string | undefined, file: string): SafeReadResult {
  try {
    const lstat = fs.lstatSync(file);
    const real = fs.realpathSync(file);
    if (lstat.isSymbolicLink() && userHomeReal && !inside(same(userHomeReal), same(real))) {
      return { status: 'absent' };
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { status: 'absent' };
    if (stat.size > MAX_SCAN_BYTES) return { status: 'oversized', size: stat.size };
    return { status: 'ok', content: fs.readFileSync(real, 'utf8') };
  } catch {
    return { status: 'absent' };
  }
}

function scanSecrets(
  content: string,
  app: AuditApp,
  file: string,
  findings: AuditFinding[],
): void {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    for (const { rule, pattern } of SECRET_RULES) {
      if (pattern.test(lineText)) {
        findings.push({
          severity: 'high',
          kind: 'credential_marker',
          app,
          file,
          line: i + 1,
          rule,
          detail: `credential-like marker (${rule}) at ${path.basename(file)}:${i + 1}`,
        });
      }
    }
  }
}

function expandPathPlaceholders(raw: string, userHome: string): { expanded: string; hasUnexpandedVar: boolean } {
  let out = raw;
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(userHome, out.slice(2));
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (full, name: string) => process.env[name] ?? full);
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name: string) => process.env[name] ?? full);
  const hasUnexpandedVar = /%[A-Za-z_][A-Za-z0-9_]*%|\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(out);
  return { expanded: out, hasUnexpandedVar };
}

function normalizeServerIdentity(s: ParsedMcpServer): string {
  const cmd = s.command
    ? (process.platform === 'win32' ? path.normalize(s.command).toLowerCase() : path.normalize(s.command))
    : '';
  const args = s.args.map(arg =>
    process.platform === 'win32' && (arg.includes('\\') || /^[A-Za-z]:/.test(arg))
      ? path.normalize(arg).toLowerCase()
      : arg,
  );
  const url = s.url ? s.url.trim() : '';
  return JSON.stringify([cmd, args, url]);
}

function extractConnectionArgs(args: readonly string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--connection' && i + 1 < args.length) {
      found.push(args[i + 1]);
      i++;
    } else if (arg.startsWith('--connection=')) {
      found.push(arg.slice('--connection='.length));
    }
  }
  return found;
}

function inspectServers(
  app: AuditApp,
  servers: readonly ParsedMcpServer[],
  home: string,
  userHome: string,
  findings: AuditFinding[],
): void {
  const byIdentity = new Map<string, ParsedMcpServer[]>();
  const connectionsDir = path.join(path.resolve(home), 'connections');
  const hasConnectionsDir = fs.existsSync(connectionsDir);

  for (const s of servers) {
    if (!s.enabled) continue;
    const ident = normalizeServerIdentity(s);
    if (ident !== '["",[],""]') {
      const list = byIdentity.get(ident) ?? [];
      list.push(s);
      byIdentity.set(ident, list);
    }
    if (s.command && /[\\/]/.test(s.command)) {
      const { expanded, hasUnexpandedVar } = expandPathPlaceholders(s.command, userHome);
      if (!hasUnexpandedVar && path.isAbsolute(expanded) && !fs.existsSync(expanded)) {
        findings.push({
          severity: 'warn',
          kind: 'missing_executable',
          app,
          file: s.source,
          server: s.name,
          detail: `${app} MCP server ${s.name} points to missing executable ${s.command}`,
        });
      }
    }
    for (const connPath of extractConnectionArgs(s.args)) {
      const { expanded, hasUnexpandedVar } = expandPathPlaceholders(connPath, userHome);
      if (hasUnexpandedVar) continue;
      const resolvedConn = path.resolve(expanded);
      if (!fs.existsSync(resolvedConn)) {
        findings.push({
          severity: 'warn',
          kind: 'missing_connection',
          app,
          file: s.source,
          server: s.name,
          detail: `${app} MCP server ${s.name} references missing connection file ${connPath}`,
        });
      } else if (hasConnectionsDir && !inside(same(connectionsDir), same(resolvedConn))) {
        findings.push({
          severity: 'warn',
          kind: 'drifted_connection',
          app,
          file: s.source,
          server: s.name,
          detail: `${app} MCP server ${s.name} connection ${connPath} sits outside ${connectionsDir}`,
        });
      }
    }
  }

  for (const group of byIdentity.values()) {
    if (group.length > 1) {
      const names = group.map(s => s.name);
      findings.push({
        severity: 'warn',
        kind: 'duplicate_mcp_server',
        app,
        file: group[0].source,
        servers: names,
        detail: `${app} has duplicate enabled MCP registrations (${names.join(', ')}) pointing to the same target`,
      });
    }
  }
}

function parseJsonMcpEntries(
  raw: Record<string, unknown>,
  source: string,
): ParsedMcpServer[] {
  const out: ParsedMcpServer[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    out.push({
      name,
      source,
      enabled: obj.disabled === true || obj.enabled === false ? false : true,
      ...(typeof obj.command === 'string' ? { command: obj.command } : {}),
      args: Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === 'string') : [],
      ...(typeof obj.url === 'string' ? { url: obj.url } : typeof obj.serverUrl === 'string' ? { url: obj.serverUrl } : {}),
    });
  }
  return out;
}

export function auditHosts(options: {
  home: string;
  userHome: string;
  apps?: readonly AuditApp[];
}): HostAuditReport {
  const home = path.resolve(options.home);
  const userHome = path.resolve(options.userHome);
  const apps: AuditApp[] = options.apps?.length ? [...options.apps] : [...DEFAULT_APPS];
  let userHomeReal: string | undefined;
  try { userHomeReal = fs.realpathSync(userHome); } catch { userHomeReal = undefined; }

  const scannedFiles: string[] = [];
  const findings: AuditFinding[] = [];

  const scanFile = (app: AuditApp, file: string): string | null => {
    const res = readSafeFile(userHomeReal, file);
    if (res.status === 'oversized') {
      findings.push({
        severity: 'warn',
        kind: 'config_invalid',
        app,
        file,
        detail: `${file} exceeds 2 MiB audit scan limit (${res.size} bytes); not scanned`,
      });
      return null;
    }
    if (res.status === 'absent') return null;
    scannedFiles.push(file);
    scanSecrets(res.content, app, file, findings);
    return res.content;
  };

  if (apps.includes('codex')) {
    const tomlFile = path.join(userHome, '.codex', 'config.toml');
    const toml = scanFile('codex', tomlFile);
    if (toml !== null) {
      inspectServers('codex', parseCodexMcpServers(toml, tomlFile), home, userHome, findings);
    }
    scanFile('codex', path.join(userHome, '.codex', 'hooks.json'));
    scanFile('codex', path.join(userHome, '.codex', 'AGENTS.md'));
  }

  if (apps.includes('claude')) {
    const claudeJson = path.join(userHome, '.claude.json');
    const raw = scanFile('claude', claudeJson);
    if (raw !== null) {
      try {
        const data = JSON.parse(raw) as {
          mcpServers?: Record<string, unknown>;
          projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
        };
        if (data?.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)) {
          inspectServers('claude', parseJsonMcpEntries(data.mcpServers, claudeJson), home, userHome, findings);
        }
        if (data?.projects && typeof data.projects === 'object' && !Array.isArray(data.projects)) {
          for (const [projPath, projCfg] of Object.entries(data.projects)) {
            if (projCfg?.mcpServers && typeof projCfg.mcpServers === 'object' && !Array.isArray(projCfg.mcpServers)) {
              inspectServers('claude', parseJsonMcpEntries(projCfg.mcpServers, `${claudeJson}#projects:${projPath}`), home, userHome, findings);
            }
          }
        }
      } catch {
        findings.push({
          severity: 'warn',
          kind: 'config_invalid',
          app: 'claude',
          file: claudeJson,
          detail: `${claudeJson} is not valid JSON`,
        });
      }
    }
    scanFile('claude', path.join(userHome, '.claude', 'settings.json'));
    scanFile('claude', path.join(userHome, '.claude', 'CLAUDE.md'));
  }

  if (apps.includes('antigravity')) {
    const agDir = path.join(userHome, '.gemini', 'config');
    const globalCfg = path.join(agDir, 'mcp_config.json');
    const agServers: ParsedMcpServer[] = [];
    const byName = new Map<string, string[]>();

    const collectAgConfig = (file: string) => {
      const raw = scanFile('antigravity', file);
      if (raw === null) return;
      try {
        const data = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
        if (data?.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)) {
          const parsed = parseJsonMcpEntries(data.mcpServers, file);
          agServers.push(...parsed);
          for (const s of parsed) {
            if (!s.enabled) continue;
            const list = byName.get(s.name) ?? [];
            list.push(file);
            byName.set(s.name, list);
          }
        }
      } catch {
        findings.push({
          severity: 'warn',
          kind: 'config_invalid',
          app: 'antigravity',
          file,
          detail: `${file} is not valid JSON`,
        });
      }
    };

    collectAgConfig(globalCfg);
    const pluginsDir = path.join(agDir, 'plugins');
    try {
      for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        collectAgConfig(path.join(pluginsDir, entry.name, 'mcp_config.json'));
      }
    } catch { /* no plugins directory */ }

    for (const [name, files] of byName.entries()) {
      if (files.length > 1) {
        findings.push({
          severity: 'warn',
          kind: 'mcp_name_collision',
          app: 'antigravity',
          file: files[0],
          server: name,
          detail: `antigravity MCP server name ${name} is defined in multiple configs (${files.join(', ')})`,
        });
      }
    }
    inspectServers('antigravity', agServers, home, userHome, findings);
    scanFile('antigravity', path.join(userHome, '.gemini', 'GEMINI.md'));
  }

  try {
    if (manifestPath(home)) {
      const manifest = loadManifest(home);
      if (manifest) {
        const status = hubStatus(manifest, { userHome });
        for (const skill of status.skills) {
          for (const app of apps) {
            if (skill.apps[app] === 'conflict') {
              findings.push({
                severity: 'warn',
                kind: 'tool_hub_conflict',
                app,
                file: manifest.path,
                detail: `tool-hub skill ${skill.name} has a conflict in ${app}`,
              });
            }
          }
        }
        for (const server of status.servers) {
          for (const app of apps) {
            if (server.apps[app] === 'conflict') {
              findings.push({
                severity: 'warn',
                kind: 'tool_hub_conflict',
                app,
                file: manifest.path,
                server: server.name,
                detail: `tool-hub server ${server.name} has a conflict in ${app}`,
              });
            }
          }
        }
      }
    }
  } catch (error) {
    findings.push({
      severity: 'warn',
      kind: 'config_invalid',
      app: 'shared',
      file: path.join(home, 'tools.json'),
      detail: (error as Error).message,
    });
  }

  return {
    home,
    userHome,
    apps,
    scannedFiles,
    findings,
    clean: findings.length === 0,
  };
}

export function formatHostAudit(report: HostAuditReport): string {
  const lines = [
    `host audit: ${report.clean ? 'clean' : `${report.findings.length} finding(s)`} (apps: ${report.apps.join(', ')}; files scanned: ${report.scannedFiles.length})`,
  ];
  for (const f of report.findings) {
    lines.push(`  [${f.severity}] ${f.kind} (${f.app}): ${f.detail}`);
  }
  return lines.join('\n');
}

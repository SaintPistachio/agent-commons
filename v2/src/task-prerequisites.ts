import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { git } from './adapters/shared.ts';
import { fail } from './errors.ts';

export interface TaskDependency { task_id: string; kind: 'done' | 'git' }
export interface EditBase { root: string; revision: string }
export interface DependencyIssue { task: string; reason: string }
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function commitAt(root: string, ref: string): string {
  if (ref !== 'HEAD' && !SHA.test(ref)) throw new Error('A full Git commit ID is required');
  return git(root, ['rev-parse', '--verify', ref + '^{commit}']);
}

/** undefined checks task status only; null also reports missing Git base evidence. */
export function prerequisiteIssues(db: DatabaseSync, deps: TaskDependency[], base?: EditBase | null): DependencyIssue[] {
  if (!deps.length) return [];
  const find = db.prepare('SELECT seq,status,integrated_revision FROM tasks WHERE id=?');
  const issues: DependencyIssue[] = [];
  for (const dep of deps) {
    const row = find.get(dep.task_id);
    const task = row ? `t${row.seq}` : dep.task_id;
    if (!row || row.status !== 'done') {
      issues.push({ task, reason: row ? String(row.status).replaceAll('_', ' ') : 'missing task' });
    } else if (dep.kind === 'git' && base !== undefined) {
      if (!row.integrated_revision) issues.push({ task, reason: 'awaiting integration commit' });
      else if (!base) issues.push({ task, reason: 'Git base unavailable' });
      else {
        try {
          git(base.root, ['merge-base', '--is-ancestor', String(row.integrated_revision), base.revision]);
        } catch (error) {
          issues.push({ task, reason: (error as { status?: number }).status === 1
            ? 'integration commit missing from base' : 'Git ancestry unavailable' });
        }
      }
    }
  }
  return issues;
}

export const describePrerequisiteIssues = (issues: DependencyIssue[]) =>
  issues.map(issue => `${issue.task} (${issue.reason})`).join(', ');

export function editScopes(paths: string[], windows = process.platform === 'win32'): string[] {
  return [...new Set(paths.map(value => {
    const forward = value.replaceAll('\\', '/');
    if (forward.startsWith('/') || /[<>:"*?|\x00-\x1f]/.test(forward)
      || forward.split('/').some(part => part === '..' || (windows && part !== '.' && /[ .]$/.test(part))))
      fail('INVALID_INPUT', 400, 'edit_paths must be repository-relative file or directory paths');
    return path.posix.normalize(forward).replace(/\/$/, '');
  }))];
}

export function overlappingEditScope(a: string, b: string, windows = process.platform === 'win32'): string | undefined {
  const left = windows ? a.toLowerCase() : a, right = windows ? b.toLowerCase() : b;
  if (left === '.' || right.startsWith(left + '/')) return b;
  if (right === '.' || left === right || left.startsWith(right + '/')) return a;
  return undefined;
}

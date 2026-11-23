import path from 'node:path';

/**
 * The Agent Commons home (database, connections, backups, job logs, helper state and releases) is never under
 * the user profile. An installed release runs from <home>\app\<commit>\v2\src or <home>\current\v2\src, so it
 * finds its own home; a source checkout must be given one (--home or AGENT_COMMONS_HOME).
 */
export function defaultHome(entry: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AGENT_COMMONS_HOME) return path.resolve(env.AGENT_COMMONS_HOME);
  const src = path.dirname(path.resolve(entry));
  if (path.basename(src).toLowerCase() !== 'src' || path.basename(path.dirname(src)).toLowerCase() !== 'v2') return undefined;
  const release = path.dirname(path.dirname(src));
  if (path.basename(path.dirname(release)).toLowerCase() === 'app') return path.dirname(path.dirname(release));
  if (path.basename(release).toLowerCase() === 'current') return path.dirname(release);
  return undefined;
}

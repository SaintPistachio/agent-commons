/** Production jobs run only through adapters with a qualified tool boundary. */
export type WorkerPolicy = (route: string, toolset: string | null, mode?: string, patchEdit?: boolean) => string | null;

export const releaseWorkerPolicy: WorkerPolicy = (route, toolset, mode, patchEdit) => {
  if (route !== 'openai-api') return 'WORKER_ROUTE_GATED';
  if (toolset !== null && toolset !== 'project') return 'WORKER_TOOLSET_GATED';
  if ((patchEdit && (mode !== 'edit' || toolset !== null)) || (mode === 'edit' && !patchEdit)) return 'WORKER_MODE_GATED';
  return null;
};

export function workerPolicyMessage(code: string): string {
  if (code === 'WORKER_MODE_GATED') return 'Delegated edits require an approved isolated patch check.';
  return code === 'WORKER_TOOLSET_GATED'
    ? 'Only the built-in project tool set is qualified for delegated jobs.'
    : 'This delegated worker route has not passed tool isolation qualification.';
}

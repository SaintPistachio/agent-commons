/** Shared display options for both wait commands. Null means the flag was given without a value. */
export function waitDisplayOptions(brief: boolean, maxChars?: string | null): { brief?: true; max_chars?: number } {
  const limit = maxChars === undefined ? undefined : Number(maxChars);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 20 || limit > 200000))
    throw Object.assign(new Error('--max-chars must be an integer from 20 to 200000'), { code: 'INVALID_INPUT' });
  return { ...(brief ? { brief: true } : {}), ...(limit !== undefined ? { max_chars: limit } : {}) };
}

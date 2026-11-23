import { RemoteError } from './client.ts';
import { errLine, splitLocated } from './air/format.ts';

/** AIR-T tools answer in compact text only: no structuredContent copy of the same payload. */
const AIR_TOOLS = new Set(['air_tx', 'air_sync', 'air_get', 'air_wait', 'art_put']);

/** The MCP result for a successful tool call. */
export function toolReply(name: string, result: any) {
  if (AIR_TOOLS.has(name) && typeof result?.air === 'string') return { content: [{ type: 'text', text: result.air }] };
  return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
}

/**
 * The MCP result for a failed tool call. AIR-T tools get an `@air1 err ...` line, and so does every error on an
 * AIR-profile connection (`airProfile`), including a refused JSON tool name.
 */
export function toolError(name: string, error: unknown, input: Record<string, unknown>, airProfile = false) {
  const code = error instanceof RemoteError ? error.code : 'SERVICE_UNAVAILABLE_OR_UNKNOWN_OUTCOME';
  const retry = code === 'SERVICE_UNAVAILABLE_OR_UNKNOWN_OUTCOME' && input.operation_id ? 'Retry with the same operation_id once the service is back.' : undefined;
  if (airProfile || AIR_TOOLS.has(name)) {
    const located = splitLocated((error as Error).message);
    return { isError: true, content: [{ type: 'text', text: errLine(code, located.message + (retry ? ' ' + retry : ''), located.line, located.node) }] };
  }
  const value = { error: { code, message: (error as Error).message, ...(retry ? { retry } : {}) } };
  return { isError: true, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

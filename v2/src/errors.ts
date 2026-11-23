/** Errors the service reports to callers as { code, message } with an HTTP status. */
export class CommonsError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, message = code, status = 400) { super(message); this.code = code; this.status = status; }
}
export const fail = (code: string, status = 400, message = code): never => { throw new CommonsError(code, message, status); };

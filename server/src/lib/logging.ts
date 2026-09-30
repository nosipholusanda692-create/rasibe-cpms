import { randomUUID } from 'node:crypto';

/**
 * Server-fault logging (NFR-PRI-006).
 *
 * A PostgreSQL error carries the failing statement and the row values that
 * caused it: `message` names the value on a unique violation, `detail` and
 * `where` repeat it, and `internalQuery` holds the statement raised inside a
 * trigger. Printing the error object puts all of that in the log, where it is
 * neither access controlled nor covered by the retention rules.
 *
 * Only the identifiers needed to find the fault are recorded. The caller
 * returns the same identifier to the client, so a reported failure can be
 * matched to its log line without the response carrying internals either.
 */
export const newErrorId = (): string => randomUUID();

export function logServerError(
  errorId: string,
  err: unknown,
  method: string,
  path: string,
): void {
  const e = err as Record<string, unknown> | null | undefined;
  const fields = [`id=${errorId}`, `${method} ${path}`, `name=${String(e?.name ?? 'Error')}`];

  // SQLSTATE, the constraint and the routine name locate the failure. None of
  // them carry row values.
  for (const key of ['code', 'constraint', 'routine'] as const) {
    if (typeof e?.[key] === 'string') fields.push(`${key}=${e[key]}`);
  }
  console.error(`[error] ${fields.join(' ')}`);

  // A fault in our own code is worth a stack trace while developing. A database
  // error never is: its message and detail are the values we are hiding.
  const isDbError = typeof e?.code === 'string' && (e.code as string).length === 5;
  if (!isDbError && process.env.NODE_ENV !== 'production' && typeof e?.stack === 'string') {
    console.error(e.stack);
  }
}

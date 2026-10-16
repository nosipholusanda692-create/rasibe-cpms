/**
 * The API must connect as an ordinary role, or row-level security does nothing
 * (BR-013, NFR-SEC-002).
 *
 * Three things switch the policies off for a connection, and none of them
 * produces an error: the role is a superuser, the role has BYPASSRLS, or the
 * role owns the table (an owner is exempt from its own table's policies unless
 * FORCE ROW LEVEL SECURITY is set). Hosted databases make the mistake easy: the
 * default connection string they show is for the owner, which has BYPASSRLS.
 * A client manager would then see every client's data and nothing would fail.
 *
 * So the API looks at its own login before it listens. In production it refuses
 * to start; elsewhere it warns, so a developer on a local superuser account is
 * told rather than blocked. There is deliberately no setting to switch it off.
 */
import { anonQuery } from './db.js';

export interface RoleFacts {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** Tables in the public schema owned by this role. */
  ownedTables: string[];
  /** Tables with policies defined but row-level security switched off. */
  unprotectedTables: string[];
}

type Reader = (text: string, params?: unknown[]) => Promise<any[]>;

export async function readRoleFacts(read: Reader = anonQuery): Promise<RoleFacts> {
  const me = await read(
    `SELECT current_user AS role, r.rolsuper, r.rolbypassrls
       FROM pg_roles r WHERE r.rolname = current_user`);
  if (!me[0]) throw new Error('The connected role was not found in pg_roles.');

  const owned = await read(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tableowner = current_user ORDER BY tablename`);
  const unprotected = await read(
    `SELECT DISTINCT c.relname FROM pg_class c
       JOIN pg_policy p ON p.polrelid = c.oid
      WHERE NOT c.relrowsecurity ORDER BY c.relname`);

  return {
    role: me[0].role,
    superuser: me[0].rolsuper === true,
    bypassRls: me[0].rolbypassrls === true,
    ownedTables: owned.map((r) => r.tablename),
    unprotectedTables: unprotected.map((r) => r.relname),
  };
}

/** Every reason these facts mean the policies are not protecting anything. */
export function roleProblems(f: RoleFacts): string[] {
  const problems: string[] = [];
  if (f.superuser) {
    problems.push(`"${f.role}" is a superuser, which ignores every row-level security policy`);
  }
  if (f.bypassRls) {
    problems.push(`"${f.role}" has BYPASSRLS, which ignores every row-level security policy`);
  }
  if (f.ownedTables.length) {
    problems.push(
      `"${f.role}" owns ${f.ownedTables.length} table(s) (${f.ownedTables.slice(0, 3).join(', ')}` +
      `${f.ownedTables.length > 3 ? ', ...' : ''}), and an owner is exempt from its own table's policies`);
  }
  if (f.unprotectedTables.length) {
    problems.push(
      `policies are defined on ${f.unprotectedTables.join(', ')} but row-level security is switched off there`);
  }
  return problems;
}

const FIX = 'Connect as rasibe_app (PGUSER), not the database owner. See docs/DEPLOY.md.';

/**
 * Called once before the server listens. Throws in production; elsewhere logs.
 * A check that cannot run counts as a failure in production: the point is that
 * nothing is assumed.
 */
export async function enforceAppRole(
  read: Reader = anonQuery,
  env: string | undefined = process.env.NODE_ENV,
): Promise<void> {
  const production = env === 'production';

  let problems: string[];
  try {
    problems = roleProblems(await readRoleFacts(read));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (production) throw new Error(`Could not check the database login: ${why}`);
    console.warn(`[warn] could not check the database login: ${why}`);
    return;
  }

  if (!problems.length) return;

  const message = `Row-level security would not apply to this API: ${problems.join('; ')}. ${FIX}`;
  if (production) throw new Error(message);
  console.warn(`[warn] ${message}`);
}

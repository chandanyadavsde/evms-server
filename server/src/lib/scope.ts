import type { Db } from '../db/client';
import type { AuthUser } from '../plugins/auth';

/**
 * Which places (ports and CFSs) a user works on. Admins see everything; a supervisor sees the
 * ports and CFSs an admin assigned — or everything while none are assigned yet.
 * Returns null for "all places".
 */
export async function placesInScope(db: Db, user: AuthUser): Promise<string[] | null> {
  if (user.roles.includes('admin')) return null;
  const rows = await db
    .selectFrom('user_scopes')
    .select('location_id')
    .where('tenant_id', '=', user.tid)
    .where('user_id', '=', user.sub)
    .execute();
  return rows.length ? rows.map((r) => r.location_id) : null;
}

export const inScope = (scope: string[] | null, ...locationIds: (string | null | undefined)[]) =>
  scope === null || locationIds.some((id) => !!id && scope.includes(id));

import type { Db } from '../db/client';

/** JSONB columns are written as JSON text (works the same on pg and PGlite). */
export const json = (value: unknown): string => JSON.stringify(value);

export const num = (value: string | number | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

/** Appends to the event log — the memory of the "mini world". */
export async function recordEvent(
  db: Db,
  e: {
    tenantId: string;
    entity: string;
    entityId: string;
    type: string;
    actorId?: string | null;
    payload?: unknown;
  },
): Promise<void> {
  await db
    .insertInto('events')
    .values({
      tenant_id: e.tenantId,
      entity: e.entity,
      entity_id: e.entityId,
      type: e.type,
      actor_id: e.actorId ?? null,
      payload: json(e.payload ?? {}),
    })
    .execute();
}

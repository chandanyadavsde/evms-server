import type { ConfirmedMove, IntakeDraft } from '@vms/contracts';
import type { Db } from '../../db/client';
import { isValidContainerNumber, normalizeContainerNumber } from '../../domain/container-number';
import { buildDraft, type IntakeMaster } from '../../domain/intake';
import { json, recordEvent } from '../../lib/db-utils';
import { AppError, badRequest, notFound } from '../../lib/errors';
import type { AuthUser } from '../../plugins/auth';
import { loadFile } from '../ai/service';
import { createMove } from '../operations/service';
import { IntakeError, type IntakeReader } from './reader';

export interface IntakeDeps {
  db: Db;
  reader: IntakeReader;
  filesDir: string;
  now?: () => Date;
}

export async function loadIntakeMaster(db: Db, tenantId: string): Promise<IntakeMaster> {
  const [clients, locations, cargoTypes, jobTypes] = await Promise.all([
    db
      .selectFrom('clients')
      .select(['id', 'code', 'name', 'aliases'])
      .where('tenant_id', '=', tenantId)
      .where('active', '=', true)
      .execute(),
    db
      .selectFrom('locations as l')
      .innerJoin('location_types as lt', 'lt.id', 'l.location_type_id')
      .select(['l.id', 'l.code', 'l.name', 'l.aliases', 'lt.code as type'])
      .where('l.tenant_id', '=', tenantId)
      .execute(),
    db
      .selectFrom('cargo_types')
      .select(['id', 'code', 'name', 'attributes'])
      .where('tenant_id', '=', tenantId)
      .execute(),
    db
      .selectFrom('job_types as j')
      .innerJoin('location_types as f', 'f.id', 'j.from_location_type_id')
      .innerJoin('location_types as t', 't.id', 'j.to_location_type_id')
      .select(['j.id', 'j.code', 'j.name', 'f.code as fromType', 't.code as toType'])
      .where('j.tenant_id', '=', tenantId)
      // Only trip types in use: a message about a switched-off type stays unsure for the manager.
      .where('j.active', '=', true)
      .execute(),
  ]);
  return {
    clients: clients.map((c) => ({ ...c, aliases: c.aliases ?? [] })),
    locations: locations.map((l) => ({ ...l, aliases: l.aliases ?? [] })),
    cargoTypes: cargoTypes.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      size: ((c.attributes as { size?: string }).size ?? null) as string | null,
    })),
    jobTypes,
  };
}

/** Marks drafts whose container number is already on an open move. */
async function flagDuplicates(db: Db, tenantId: string, draft: IntakeDraft) {
  const numbers = draft.moves.map((m) => m.containerNumber.value).filter((n): n is string => !!n);
  if (!numbers.length) return;
  const open = await db
    .selectFrom('moves as m')
    .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
    .select(['m.id', 'c.identifier'])
    .where('m.tenant_id', '=', tenantId)
    .where('m.status', 'not in', ['completed', 'cancelled'])
    .where('c.identifier', 'in', numbers)
    .execute();
  let dup = 0;
  for (const d of draft.moves) {
    const hit = open.find((o) => o.identifier === d.containerNumber.value);
    if (hit) {
      d.duplicateOf = hit.id;
      dup++;
    }
  }
  if (dup) draft.questions.push(`${dup} container(s) already have an open move — remove or keep?`);
}

/** Reads pasted text and/or screenshots into a draft. Never creates moves by itself. */
export async function readIntake(
  deps: IntakeDeps,
  user: AuthUser,
  input: {
    text?: string;
    fileKeys: string[];
    source?: { kind: 'plugin'; url: string; title: string };
  },
) {
  const text = input.text?.trim() ?? '';
  if (!text && !input.fileKeys.length) {
    throw badRequest('Paste a message or add a screenshot first', [
      { field: 'text', message: 'Nothing to read' },
    ]);
  }
  const files = await Promise.all(input.fileKeys.map((k) => loadFile(deps.filesDir, user.tid, k)));
  const master = await loadIntakeMaster(deps.db, user.tid);
  const base = {
    tenant_id: user.tid,
    source_text: text || null,
    file_keys: json(input.fileKeys),
    provider: deps.reader.name,
    source: json(input.source ?? { kind: 'web' }),
    created_by: user.sub,
  };

  let raw: unknown;
  try {
    raw = await deps.reader.read({ text, files }, master, deps.now?.() ?? new Date());
  } catch (err) {
    const message =
      err instanceof IntakeError || err instanceof AppError
        ? err.message
        : 'The reader failed — try again, or type the move by hand';
    if (!(err instanceof IntakeError)) console.error('intake read failed', err);
    await deps.db
      .insertInto('intake_requests')
      .values({ ...base, status: 'failed', error: message })
      .execute();
    throw new AppError(422, message);
  }

  const draft = buildDraft(raw as Parameters<typeof buildDraft>[0], master);
  await flagDuplicates(deps.db, user.tid, draft);
  const row = await deps.db
    .insertInto('intake_requests')
    .values({ ...base, status: 'read', raw: json(raw), draft: json(draft) })
    .returning(['id', 'created_at'])
    .executeTakeFirstOrThrow();
  await recordEvent(deps.db, {
    tenantId: user.tid,
    entity: 'intake',
    entityId: row.id,
    type: 'intake.read',
    actorId: user.sub,
    payload: {
      provider: deps.reader.name,
      sourceKind: draft.sourceKind,
      moves: draft.moves.length,
      from: input.source ?? { kind: 'web' },
    },
  });
  return { id: row.id, status: 'read' as const, provider: deps.reader.name, draft };
}

export async function getIntake(db: Db, tenantId: string, id: string) {
  const row = await db
    .selectFrom('intake_requests')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Intake');
  return {
    id: row.id,
    status: row.status,
    provider: row.provider,
    text: row.source_text,
    fileKeys: row.file_keys,
    draft: row.draft as IntakeDraft | null,
    error: row.error,
    moveIds: row.move_ids,
    source: row.source,
    createdAt: row.created_at,
  };
}

export async function listIntakes(db: Db, tenantId: string) {
  const rows = await db
    .selectFrom('intake_requests as i')
    .leftJoin('users as u', 'u.id', 'i.created_by')
    .select([
      'i.id',
      'i.status',
      'i.provider',
      'i.source_text',
      'i.file_keys',
      'i.draft',
      'i.error',
      'i.move_ids',
      'i.source',
      'i.created_at',
      'u.name as createdBy',
    ])
    .where('i.tenant_id', '=', tenantId)
    .orderBy('i.created_at', 'desc')
    .limit(50)
    .execute();
  return rows.map((r) => {
    const d = r.draft as IntakeDraft | null;
    return {
      id: r.id,
      status: r.status,
      provider: r.provider,
      preview: (r.source_text ?? '')
        .replace(/^Text on the page inside the copied area:\n/, '')
        .slice(0, 120),
      source: r.source,
      files: r.file_keys.length,
      summary: d?.summary || r.error || '',
      drafts: d?.moves.length ?? 0,
      moves: r.move_ids.length,
      createdBy: r.createdBy,
      createdAt: r.created_at,
    };
  });
}

/** The manager's reviewed moves → real moves, each linked back to this intake. */
export async function confirmIntake(db: Db, user: AuthUser, id: string, moves: ConfirmedMove[]) {
  const row = await db
    .selectFrom('intake_requests')
    .select(['id', 'status'])
    .where('tenant_id', '=', user.tid)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Intake');
  if (row.status !== 'read') throw badRequest(`This intake is already ${row.status}`);
  if (!moves.length) throw badRequest('No moves to create — discard the intake instead');

  // Check everything before creating anything.
  const errors = moves.flatMap((m, i) =>
    m.containerNumber?.trim() &&
    !isValidContainerNumber(normalizeContainerNumber(m.containerNumber))
      ? [{ field: `moves.${i}.containerNumber`, message: 'Check digit does not match' }]
      : [],
  );
  if (errors.length) throw new AppError(422, 'Some container numbers are not valid', errors);

  const moveIds: string[] = [];
  for (const m of moves) {
    const created = await createMove(db, user, {
      clientId: m.clientId,
      jobTypeId: m.jobTypeId,
      cargoTypeId: m.cargoTypeId,
      fromLocationId: m.fromLocationId,
      toLocationId: m.toLocationId,
      containerNumber: m.containerNumber?.trim() || null,
      ...(m.readyAt ? { readyAt: m.readyAt } : {}),
      ...(m.cutoffAt ? { cutoffAt: m.cutoffAt } : {}),
      custom: { intakeId: id },
    });
    moveIds.push(created.id);
  }
  await db
    .updateTable('intake_requests')
    .set({
      status: 'confirmed',
      move_ids: json(moveIds),
      confirmed_by: user.sub,
      confirmed_at: new Date(),
    })
    .where('id', '=', id)
    .execute();
  await recordEvent(db, {
    tenantId: user.tid,
    entity: 'intake',
    entityId: id,
    type: 'intake.confirmed',
    actorId: user.sub,
    payload: { moveIds },
  });
  return { ok: true, moveIds };
}

export async function discardIntake(db: Db, user: AuthUser, id: string) {
  const r = await db
    .updateTable('intake_requests')
    .set({ status: 'discarded', confirmed_by: user.sub, confirmed_at: new Date() })
    .where('tenant_id', '=', user.tid)
    .where('id', '=', id)
    .where('status', 'in', ['read', 'failed'])
    .executeTakeFirst();
  if (!r.numUpdatedRows) throw badRequest('Only an unconfirmed intake can be discarded');
  await recordEvent(db, {
    tenantId: user.tid,
    entity: 'intake',
    entityId: id,
    type: 'intake.discarded',
    actorId: user.sub,
  });
  return { ok: true };
}

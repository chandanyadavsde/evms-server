import type { Db } from '../../db/client';
import {
  type FillValue,
  type FormField,
  fillFromMapping,
  fillInstructions,
  fillPrompt,
  fillSchema,
  fullyLearned,
  guessDataKey,
  type LearnedMapping,
  PASTE_KEYS,
  type PasteData,
  type PasteKey,
  pageKey,
} from '../../domain/form-fill';
import { json, recordEvent } from '../../lib/db-utils';
import { AppError } from '../../lib/errors';
import type { AuthUser } from '../../plugins/auth';
import { ModelError, type VisionModel } from '../ai/llm';

/** Planned and running jobs a manager can paste into a portal form (e.g. a PIN / gate-pass form). */
export async function pasteSources(db: Db, tenantId: string) {
  const legs = await db
    .selectFrom('legs as l')
    .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
    .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .innerJoin('drivers as d', 'd.id', 'a.driver_id')
    .innerJoin('locations as f', 'f.id', 'l.from_location_id')
    .innerJoin('locations as t', 't.id', 'l.to_location_id')
    .select([
      'l.id',
      'l.trip_id as tripId',
      'l.status',
      'l.seq',
      'v.reg_no',
      'd.name as driverName',
      'd.phone',
      'd.licence_no',
      'f.name as fromName',
      't.name as toName',
    ])
    .where('l.tenant_id', '=', tenantId)
    .where('l.status', 'in', ['planned', 'active'])
    .orderBy('l.status')
    .orderBy('l.seq')
    .limit(50)
    .execute();
  if (!legs.length) return [];
  // Name on portal forms ("Truck Company"): tenant setting transporterName, else the tenant name.
  const tenant = await db
    .selectFrom('tenants')
    .select(['name', 'settings'])
    .where('id', '=', tenantId)
    .executeTakeFirstOrThrow();
  const transporter =
    (tenant.settings as { transporterName?: string }).transporterName ?? tenant.name;
  const moves = await db
    .selectFrom('leg_moves as lm')
    .innerJoin('moves as m', 'm.id', 'lm.move_id')
    .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
    .innerJoin('cargo_types as ct', 'ct.id', 'c.cargo_type_id')
    .innerJoin('clients as cl', 'cl.id', 'm.client_id')
    .innerJoin('job_types as jt', 'jt.id', 'm.job_type_id')
    .select([
      'lm.leg_id',
      'c.identifier',
      'ct.attributes',
      'cl.name as client',
      'jt.name as jobType',
    ])
    .where(
      'lm.leg_id',
      'in',
      legs.map((l) => l.id),
    )
    .execute();

  return legs.map((l) => {
    const mine = moves.filter((m) => m.leg_id === l.id);
    const sizes = [...new Set(mine.map((m) => (m.attributes as { size?: string }).size ?? ''))];
    const size = (sizes[0] ?? '').replace(/\D/g, '');
    const data: PasteData = {
      truck_number: l.reg_no.replace(/\s+/g, ''),
      driver_name: l.driverName,
      driver_mobile: l.phone,
      ...(l.licence_no ? { driver_licence: l.licence_no } : {}),
      container_count: String(mine.length || ''),
      ...(size ? { container_size: size } : {}),
      container_numbers: mine
        .map((m) => m.identifier)
        .filter(Boolean)
        .join(', '),
      client: [...new Set(mine.map((m) => m.client))].join(', '),
      pickup: l.fromName,
      drop: l.toName,
      job_type: [...new Set(mine.map((m) => m.jobType))].join(', '),
      transporter,
    };
    return {
      legId: l.id,
      tripId: l.tripId,
      status: l.status,
      label: `${l.reg_no} · ${l.driverName} · ${mine.length}×${size || '?'}ft · ${l.fromName} → ${l.toName}`,
      data,
    };
  });
}

async function learned(db: Db, tenantId: string, key: string): Promise<LearnedMapping | null> {
  const row = await db
    .selectFrom('assist_mappings')
    .select('fields')
    .where('tenant_id', '=', tenantId)
    .where('page_key', '=', key)
    .executeTakeFirst();
  return (row?.fields as LearnedMapping | undefined) ?? null;
}

/**
 * Which data goes into which field. A page learned before is filled from the saved mapping (no AI,
 * no cost); otherwise the AI decides per field (or label rules when no AI is set up).
 */
export async function mapForm(
  deps: { db: Db; model: VisionModel | null },
  user: AuthUser,
  input: { url: string; fields: FormField[]; data: PasteData },
): Promise<{ values: FillValue[]; learned: boolean; by: string }> {
  const key = pageKey(input.url);
  const saved = await learned(deps.db, user.tid, key);
  if (fullyLearned(input.fields, saved) && saved) {
    const mapping = Object.fromEntries(
      Object.entries(saved).map(([k, v]) => [k, v.dataKey]),
    ) as Record<string, PasteKey | ''>;
    return {
      values: fillFromMapping(input.fields, mapping, input.data),
      learned: true,
      by: 'learned page',
    };
  }

  let mapping: Record<string, PasteKey | ''>;
  let by: string;
  if (deps.model) {
    try {
      const out = (await deps.model.json({
        system: fillInstructions(),
        parts: [{ text: fillPrompt(input.fields, input.data) }],
        schema: fillSchema(),
        maxTokens: 2000,
      })) as { fields: { key: string; data_key: string }[] };
      const valid = new Set(Object.keys(PASTE_KEYS));
      mapping = Object.fromEntries(
        (out.fields ?? []).map((f) => [
          f.key,
          valid.has(f.data_key) ? (f.data_key as PasteKey) : '',
        ]),
      );
      by = deps.model.name;
    } catch (err) {
      if (err instanceof ModelError) throw new AppError(422, err.message);
      throw err;
    }
  } else {
    mapping = Object.fromEntries(input.fields.map((f) => [f.key, guessDataKey(f.label)]));
    by = 'label rules (free)';
  }
  // What a manager confirmed earlier on this page wins over a fresh guess.
  for (const [k, v] of Object.entries(saved ?? {})) mapping[k] = v.dataKey;
  return { values: fillFromMapping(input.fields, mapping, input.data), learned: false, by };
}

/** The manager pressed Fill: remember the page, so the next fill is instant and free. */
export async function rememberFill(
  db: Db,
  user: AuthUser,
  input: {
    url: string;
    title: string;
    fields: { key: string; label: string; dataKey: string }[];
    legId?: string;
  },
) {
  const key = pageKey(input.url);
  const valid = new Set(['', ...Object.keys(PASTE_KEYS)]);
  const fields = Object.fromEntries(
    input.fields
      .filter((f) => valid.has(f.dataKey))
      .map((f) => [f.key, { dataKey: f.dataKey, label: f.label }]),
  );
  const prev = (await learned(db, user.tid, key)) ?? {};
  await db
    .insertInto('assist_mappings')
    .values({
      tenant_id: user.tid,
      page_key: key,
      fields: json({ ...prev, ...fields }),
      uses: 1,
      updated_by: user.sub,
    })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'page_key']).doUpdateSet((eb) => ({
        fields: json({ ...prev, ...fields }),
        uses: eb('assist_mappings.uses', '+', 1),
        updated_by: user.sub,
        updated_at: new Date(),
      })),
    )
    .execute();
  await recordEvent(db, {
    tenantId: user.tid,
    entity: input.legId ? 'leg' : 'assist',
    entityId: input.legId ?? user.sub,
    type: 'assist.form_filled',
    actorId: user.sub,
    payload: {
      page: key,
      title: input.title,
      filled: input.fields.filter((f) => f.dataKey).map((f) => f.label),
    },
  });
  return { ok: true, pageKey: key };
}

export async function listLearnedPages(db: Db, tenantId: string) {
  return db
    .selectFrom('assist_mappings')
    .select(['id', 'page_key as pageKey', 'fields', 'uses', 'updated_at as updatedAt'])
    .where('tenant_id', '=', tenantId)
    .orderBy('updated_at', 'desc')
    .execute();
}

export async function forgetPage(db: Db, tenantId: string, id: string) {
  await db
    .deleteFrom('assist_mappings')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .execute();
  return { ok: true };
}

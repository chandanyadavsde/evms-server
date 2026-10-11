import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { type ChargeLine, RateCard } from '@vms/contracts';
import type { Db } from '../../db/client';
import { priceLr } from '../../domain/charges';
import { resolveDefinition, type ScopedDefinition } from '../../domain/config-resolution';
import { json, num, recordEvent } from '../../lib/db-utils';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import type { AuthUser } from '../../plugins/auth';

// ─── Rate cards (configuration, like flows) ────────────────────────────────

export async function publishRateCard(
  db: Db,
  tenantId: string,
  card: unknown,
  scope: { clientId?: string; regionId?: string } = {},
) {
  const errors = [...Value.Errors(RateCard, card)].map((e) => `${e.path || '/'}: ${e.message}`);
  if (errors.length) throw new AppError(422, 'Rate card does not match schema', errors);
  const rc = card as RateCard;
  const existing = await db
    .selectFrom('config_definitions')
    .select(['id', 'version'])
    .where('tenant_id', '=', tenantId)
    .where('kind', '=', 'rate_card')
    .where('key', '=', rc.key)
    .where('client_id', scope.clientId ? '=' : 'is', scope.clientId ?? null)
    .where('region_id', scope.regionId ? '=' : 'is', scope.regionId ?? null)
    .orderBy('version', 'desc')
    .executeTakeFirst();
  if (existing && existing.version === rc.version) return existing.id;
  if (existing && rc.version < existing.version)
    throw new AppError(409, `Version ${rc.version} is older than ${existing.version}`);
  const row = await db
    .insertInto('config_definitions')
    .values({
      tenant_id: tenantId,
      client_id: scope.clientId ?? null,
      region_id: scope.regionId ?? null,
      kind: 'rate_card',
      key: rc.key,
      version: rc.version,
      status: 'published',
      body: json(rc),
      published_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function publishRateCardsFromDir(db: Db, tenantId: string, dir: string) {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  for (const f of files)
    await publishRateCard(db, tenantId, JSON.parse(readFileSync(join(dir, f), 'utf8')));
  return files;
}

async function resolveRateCard(
  db: Db,
  ctx: { tenantId: string; regionId: string; clientId: string; key: string },
) {
  const rows = await db
    .selectFrom('config_definitions')
    .selectAll()
    .where('kind', '=', 'rate_card')
    .where('key', '=', ctx.key)
    .where('status', '=', 'published')
    .where('tenant_id', '=', ctx.tenantId)
    .execute();
  const candidates: ScopedDefinition<RateCard>[] = rows.map((r) => ({
    id: r.id,
    key: r.key,
    version: r.version,
    status: r.status,
    tenantId: r.tenant_id,
    regionId: r.region_id,
    clientId: r.client_id,
    body: r.body as RateCard,
  }));
  return resolveDefinition(candidates, ctx);
}

// ─── Pricing an LR ──────────────────────────────────────────────────────────

/** Step timeline of a leg from its event log: when each step was entered and completed. */
async function legTimeline(db: Db, legId: string) {
  const leg = await db
    .selectFrom('legs')
    .select(['started_at'])
    .where('id', '=', legId)
    .executeTakeFirstOrThrow();
  const events = await db
    .selectFrom('events')
    .select(['payload', 'created_at'])
    .where('entity', '=', 'leg')
    .where('entity_id', '=', legId)
    .where('type', '=', 'leg.step_completed')
    .orderBy('id')
    .execute();
  const timeline: Record<string, { entered?: Date; completed?: Date }> = {};
  let enteredAt: Date | undefined = leg.started_at ?? undefined;
  for (const e of events) {
    const p = e.payload as { step: string; next: string };
    if (p.next === p.step) continue; // "report issue" loop, still in the same step
    timeline[p.step] = { ...(enteredAt ? { entered: enteredAt } : {}), completed: e.created_at };
    enteredAt = e.created_at;
  }
  return timeline;
}

/** Called when an LR closes: price it from the client's rate card. */
export async function priceClosedLr(db: Db, user: AuthUser, lrId: string) {
  const lr = await db
    .selectFrom('lrs as r')
    .innerJoin('legs as l', 'l.id', 'r.leg_id')
    .innerJoin('locations as lf', 'lf.id', 'l.from_location_id')
    .innerJoin('locations as lt', 'lt.id', 'l.to_location_id')
    .innerJoin('clients as c', 'c.id', 'r.client_id')
    .select([
      'r.id',
      'r.leg_id',
      'r.region_id',
      'r.client_id',
      'r.custom',
      'lf.code as fromCode',
      'lt.code as toCode',
      'c.billing',
    ])
    .where('r.id', '=', lrId)
    .executeTakeFirstOrThrow();
  const containers = await db
    .selectFrom('lr_moves as lm')
    .innerJoin('moves as m', 'm.id', 'lm.move_id')
    .innerJoin('job_types as jt', 'jt.id', 'm.job_type_id')
    .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
    .innerJoin('cargo_types as ct', 'ct.id', 'c.cargo_type_id')
    .select(['c.identifier', 'c.state', 'ct.attributes', 'jt.code as jobType'])
    .where('lm.lr_id', '=', lrId)
    .execute();

  const key = (lr.billing as { rateCardKey?: string }).rateCardKey ?? 'standard';
  const card = await resolveRateCard(db, {
    tenantId: user.tid,
    regionId: lr.region_id,
    clientId: lr.client_id,
    key,
  });
  if (!card) {
    await db
      .updateTable('lrs')
      .set({ custom: json({ ...lr.custom, pricingError: `No rate card "${key}"` }) })
      .where('id', '=', lrId)
      .execute();
    return;
  }
  const result = priceLr(card.body, {
    jobType: containers[0]?.jobType ?? '',
    from: lr.fromCode,
    to: lr.toCode,
    containers: containers.map((c) => ({
      number: c.identifier ?? '',
      size: (c.attributes as { size?: string }).size ?? '',
      state: c.state,
    })),
    timeline: await legTimeline(db, lr.leg_id),
  });
  await db
    .updateTable('lrs')
    .set({
      charges: json(result.lines),
      total_amount: result.total,
      rate_card_id: card.id,
      custom: json({ ...lr.custom, unpriced: result.unpriced, pricingError: null }),
    })
    .where('id', '=', lrId)
    .execute();
  await recordEvent(db, {
    tenantId: user.tid,
    entity: 'lr',
    entityId: lrId,
    type: 'lr.priced',
    actorId: user.sub,
    payload: {
      total: result.total,
      rateCard: `${card.key} v${card.version}`,
      unpriced: result.unpriced,
    },
  });

  // Autonomy: if the business allows it, clean LRs are approved without a person.
  const s = await getSettings(db, user.tid);
  if (
    (!s.billing.approvalRequired || s.autonomy.lr_charges === 'auto') &&
    !result.unpriced.length
  ) {
    await approveLr(db, user, lrId, undefined, 'auto');
  }
}

// ─── Approval and push ─────────────────────────────────────────────────────

export async function approveLr(
  db: Db,
  user: AuthUser,
  lrId: string,
  adjusted?: ChargeLine[],
  mode: 'manual' | 'auto' = 'manual',
) {
  const lr = await db
    .selectFrom('lrs')
    .selectAll()
    .where('tenant_id', '=', user.tid)
    .where('id', '=', lrId)
    .executeTakeFirst();
  if (!lr) throw notFound('LR');
  if (lr.status !== 'closed') throw badRequest('Only a closed LR can be approved');
  const unpriced = (lr.custom as { unpriced?: string[] }).unpriced ?? [];
  if (unpriced.length && !adjusted)
    throw badRequest(`No rate for ${unpriced.join(', ')} — add charges before approving`);

  const lines = adjusted
    ? adjusted.map((l) => {
        const before = (lr.charges as ChargeLine[]).find(
          (x) => x.code === l.code && x.label === l.label,
        );
        return before && before.amount === l.amount ? l : { ...l, adjustedBy: user.sub };
      })
    : (lr.charges as ChargeLine[]);
  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

  await db
    .updateTable('lrs')
    .set({
      status: 'billable',
      charges: json(lines),
      total_amount: total,
      approved_by: user.sub,
      approved_at: new Date(),
    })
    .where('id', '=', lrId)
    .execute();
  await recordEvent(db, {
    tenantId: user.tid,
    entity: 'lr',
    entityId: lrId,
    type: 'lr.approved',
    actorId: user.sub,
    payload: { total, mode, adjusted: !!adjusted },
  });
  await enqueueNetSuite(db, user.tid, lrId);
}

/** Builds the billing payload and puts it in the outbox — once per LR (idempotent). */
async function enqueueNetSuite(db: Db, tenantId: string, lrId: string) {
  const lr = await db
    .selectFrom('lrs as r')
    .innerJoin('clients as c', 'c.id', 'r.client_id')
    .innerJoin('regions as g', 'g.id', 'r.region_id')
    .innerJoin('legs as l', 'l.id', 'r.leg_id')
    .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
    .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .innerJoin('locations as lf', 'lf.id', 'l.from_location_id')
    .innerJoin('locations as lt', 'lt.id', 'l.to_location_id')
    .select([
      'r.id',
      'r.number',
      'r.charges',
      'r.total_amount',
      'r.issued_at',
      'r.closed_at',
      'c.code as clientCode',
      'c.name as clientName',
      'c.gstin',
      'g.billing_entity',
      'v.reg_no',
      'lf.code as fromCode',
      'lt.code as toCode',
    ])
    .where('r.id', '=', lrId)
    .executeTakeFirstOrThrow();
  const containers = await db
    .selectFrom('lr_moves as lm')
    .innerJoin('moves as m', 'm.id', 'lm.move_id')
    .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
    .select(['c.identifier'])
    .where('lm.lr_id', '=', lrId)
    .execute();
  const payload = {
    externalId: `VMS-LR-${lr.id}`,
    lrNumber: lr.number,
    customer: { code: lr.clientCode, name: lr.clientName, gstin: lr.gstin },
    billingEntity: lr.billing_entity,
    vehicle: lr.reg_no,
    route: { from: lr.fromCode, to: lr.toCode },
    containers: containers.map((c) => c.identifier),
    issuedAt: lr.issued_at,
    closedAt: lr.closed_at,
    lines: lr.charges,
    total: num(lr.total_amount),
  };
  await db
    .insertInto('integration_outbox')
    .values({
      tenant_id: tenantId,
      target: 'netsuite',
      entity: 'lr',
      entity_id: lrId,
      payload: json(payload),
    })
    .onConflict((oc) => oc.columns(['target', 'entity', 'entity_id']).doNothing())
    .execute();
}

export async function lrDetail(db: Db, tenantId: string, lrId: string) {
  const lr = await db
    .selectFrom('lrs as r')
    .innerJoin('clients as c', 'c.id', 'r.client_id')
    .innerJoin('legs as l', 'l.id', 'r.leg_id')
    .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
    .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .innerJoin('drivers as d', 'd.id', 'a.driver_id')
    .innerJoin('locations as lf', 'lf.id', 'l.from_location_id')
    .innerJoin('locations as lt', 'lt.id', 'l.to_location_id')
    .innerJoin('tenants as t', 't.id', 'r.tenant_id')
    .leftJoin('config_definitions as rc', 'rc.id', 'r.rate_card_id')
    .select([
      'r.id',
      'r.number',
      'r.status',
      'r.charges',
      'r.total_amount',
      'r.custom',
      'r.created_at as createdAt',
      'r.issued_at as issuedAt',
      'r.closed_at as closedAt',
      'r.approved_at as approvedAt',
      'r.pushed_at as pushedAt',
      'r.netsuite_ref as netsuiteRef',
      'l.id as legId',
      'l.trip_id as tripId',
      'l.process_instance_id',
      'c.name as clientName',
      'c.gstin as clientGstin',
      't.name as companyName',
      'v.reg_no as vehicleRegNo',
      'd.name as driverName',
      'lf.name as fromName',
      'lt.name as toName',
      'rc.key as rateCardKey',
      'rc.version as rateCardVersion',
    ])
    .where('r.tenant_id', '=', tenantId)
    .where('r.id', '=', lrId)
    .executeTakeFirst();
  if (!lr) throw notFound('LR');
  const [containers, evidence, outbox] = await Promise.all([
    db
      .selectFrom('lr_moves as lm')
      .innerJoin('moves as m', 'm.id', 'lm.move_id')
      .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
      .innerJoin('cargo_types as ct', 'ct.id', 'c.cargo_type_id')
      .select(['c.identifier as number', 'ct.attributes', 'c.state'])
      .where('lm.lr_id', '=', lrId)
      .execute(),
    lr.process_instance_id
      ? db
          .selectFrom('evidence')
          .select([
            'step_key',
            'field_key',
            'kind',
            'doc_type',
            'file_key',
            'value',
            'ai_result',
            'captured_at',
          ])
          .where('process_instance_id', '=', lr.process_instance_id)
          .orderBy('captured_at')
          .execute()
      : Promise.resolve([]),
    db
      .selectFrom('integration_outbox')
      .selectAll()
      .where('entity', '=', 'lr')
      .where('entity_id', '=', lrId)
      .executeTakeFirst(),
  ]);
  const { process_instance_id: _, total_amount, ...rest } = lr;
  return {
    ...rest,
    total: num(total_amount),
    containers: containers.map((c) => ({
      number: c.number,
      size: (c.attributes as { size?: string }).size ?? '',
      state: c.state,
    })),
    evidence,
    outbox: outbox
      ? {
          status: outbox.status,
          attempts: outbox.attempts,
          lastError: outbox.last_error,
          externalRef: outbox.external_ref,
        }
      : null,
  };
}

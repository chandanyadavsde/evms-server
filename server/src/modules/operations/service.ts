import type { FlowDefinition, Screen, StepDef } from '@vms/contracts';
import type { Db } from '../../db/client';
import { checkCapacity } from '../../domain/capacity';
import { isValidContainerNumber, normalizeContainerNumber } from '../../domain/container-number';
import { localize } from '../../domain/i18n';
import { msg } from '../../domain/messages';
import { buildScreen } from '../../domain/screen-builder';
import { findStep, performAction, type StepContext, stepPosition } from '../../domain/workflow';
import { json, num, recordEvent } from '../../lib/db-utils';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { type AuthUser, isStaff } from '../../plugins/auth';
import { templateForField } from '../ai/service';
import { priceClosedLr } from '../billing/service';
import { getFlow, resolveWorkflow } from '../config/service';
import { recordChoice } from '../dispatch/service';

const EMPTY_FLOW_KEY = 'empty_run';

// ─── Moves ──────────────────────────────────────────────────────────────────

export interface CreateMoveInput {
  clientId: string;
  jobTypeId: string;
  /** Optional: a portal pendency gives counts, not numbers. Required before the LR is issued. */
  containerNumber?: string | null;
  cargoTypeId: string;
  fromLocationId: string;
  toLocationId: string;
  readyAt?: string;
  cutoffAt?: string;
  custom?: Record<string, unknown>;
}

export async function createMove(db: Db, user: AuthUser, input: CreateMoveInput) {
  const containerNumber = input.containerNumber?.trim()
    ? checkedContainerNumber(input.containerNumber)
    : null;
  const from = await db
    .selectFrom('locations')
    .select(['id', 'region_id'])
    .where('tenant_id', '=', user.tid)
    .where('id', '=', input.fromLocationId)
    .executeTakeFirst();
  if (!from) throw notFound('Pickup location');

  return db.transaction().execute(async (tx) => {
    const cargo = await tx
      .insertInto('cargo')
      .values({
        tenant_id: user.tid,
        cargo_type_id: input.cargoTypeId,
        identifier: containerNumber,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const move = await tx
      .insertInto('moves')
      .values({
        tenant_id: user.tid,
        region_id: from.region_id,
        client_id: input.clientId,
        job_type_id: input.jobTypeId,
        cargo_id: cargo.id,
        from_location_id: input.fromLocationId,
        to_location_id: input.toLocationId,
        ready_at: input.readyAt ?? null,
        cutoff_at: input.cutoffAt ?? null,
        custom: json(input.custom ?? {}),
        created_by: user.sub,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordEvent(tx, {
      tenantId: user.tid,
      entity: 'move',
      entityId: move.id,
      type: 'move.created',
      actorId: user.sub,
      payload: { containerNumber },
    });
    return { id: move.id };
  });
}

function checkedContainerNumber(text: string, field = 'containerNumber'): string {
  const n = normalizeContainerNumber(text);
  if (!isValidContainerNumber(n)) {
    throw badRequest('Not a valid container number (check digit)', [
      { field, message: 'Check digit does not match' },
    ]);
  }
  return n;
}

/** Fills in (or corrects) a move's container number before the LR is issued. */
export async function setMoveContainer(db: Db, user: AuthUser, moveId: string, number: string) {
  const containerNumber = checkedContainerNumber(number);
  const move = await db
    .selectFrom('moves as m')
    .leftJoin('lr_moves as lm', 'lm.move_id', 'm.id')
    .leftJoin('lrs as l', 'l.id', 'lm.lr_id')
    .select(['m.id', 'm.cargo_id', 'm.status', 'l.status as lrStatus'])
    .where('m.tenant_id', '=', user.tid)
    .where('m.id', '=', moveId)
    .executeTakeFirst();
  if (!move) throw notFound('Move');
  if (move.status === 'cancelled' || (move.lrStatus && move.lrStatus !== 'pre_lr')) {
    throw badRequest('The container number can no longer be changed (LR already issued)');
  }
  await db
    .updateTable('cargo')
    .set({ identifier: containerNumber })
    .where('tenant_id', '=', user.tid)
    .where('id', '=', move.cargo_id)
    .execute();
  await recordEvent(db, {
    tenantId: user.tid,
    entity: 'move',
    entityId: moveId,
    type: 'move.container_set',
    actorId: user.sub,
    payload: { containerNumber },
  });
  return { ok: true, containerNumber };
}

/** A move can be cancelled only before it is on a trip; it stays in history as cancelled. */
export async function cancelMove(db: Db, user: AuthUser, moveId: string, reason?: string) {
  const move = await db
    .selectFrom('moves')
    .select(['id', 'status'])
    .where('tenant_id', '=', user.tid)
    .where('id', '=', moveId)
    .executeTakeFirst();
  if (!move) throw notFound('Move');
  if (move.status !== 'pending') throw badRequest('Only a pending move can be cancelled');
  await db.updateTable('moves').set({ status: 'cancelled' }).where('id', '=', moveId).execute();
  await recordEvent(db, {
    tenantId: user.tid,
    entity: 'move',
    entityId: moveId,
    type: 'move.cancelled',
    actorId: user.sub,
    payload: { reason: reason ?? null },
  });
  return { ok: true };
}

export async function listMoves(db: Db, tenantId: string, status?: string) {
  let q = db
    .selectFrom('moves as m')
    .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
    .innerJoin('cargo_types as ct', 'ct.id', 'c.cargo_type_id')
    .innerJoin('clients as cl', 'cl.id', 'm.client_id')
    .innerJoin('job_types as jt', 'jt.id', 'm.job_type_id')
    .innerJoin('locations as lf', 'lf.id', 'm.from_location_id')
    .innerJoin('locations as lt', 'lt.id', 'm.to_location_id')
    .select([
      'm.id',
      'm.status',
      'm.ready_at as readyAt',
      'm.cutoff_at as cutoffAt',
      'm.created_at as createdAt',
      'm.custom',
      'c.identifier as containerNumber',
      'ct.code as cargoTypeCode',
      'ct.attributes as cargoAttributes',
      'cl.name as clientName',
      'cl.code as clientCode',
      'jt.name as jobTypeName',
      'lf.id as fromId',
      'lf.name as fromName',
      'lt.id as toId',
      'lt.name as toName',
    ])
    .where('m.tenant_id', '=', tenantId)
    .orderBy('m.created_at', 'desc');
  if (status) q = q.where('m.status', '=', status as never);
  const rows = await q.execute();
  return rows.map(({ cargoAttributes, custom, ...r }) => ({
    ...r,
    portal: (custom as { portal?: Record<string, unknown> }).portal ?? null,
    size: (cargoAttributes as { size?: string }).size ?? r.cargoTypeCode,
  }));
}

// ─── Trips & legs ───────────────────────────────────────────────────────────

export interface LegInput {
  fromLocationId: string;
  toLocationId: string;
  moveIds: string[];
  /** Different driver from this leg on (shift change). Vehicle stays the same. */
  driverId?: string;
}

export async function createTrip(
  db: Db,
  user: AuthUser,
  input: { vehicleId: string; driverId: string; legs: LegInput[] },
) {
  if (!input.legs.length) throw badRequest('A trip needs at least one leg');
  const vehicle = await db
    .selectFrom('vehicles')
    .select(['id', 'region_id', 'status'])
    .where('tenant_id', '=', user.tid)
    .where('id', '=', input.vehicleId)
    .executeTakeFirst();
  if (!vehicle) throw notFound('Vehicle');
  if (vehicle.status !== 'active') throw badRequest('Vehicle is not active');

  const busy = await db
    .selectFrom('legs')
    .innerJoin('assignments as a', 'a.id', 'legs.assignment_id')
    .select('legs.id')
    .where('a.vehicle_id', '=', vehicle.id)
    .where('legs.status', 'in', ['planned', 'active'])
    .executeTakeFirst();
  if (busy) throw new AppError(409, 'Vehicle already has an open trip — add a leg to it instead');

  return db.transaction().execute(async (tx) => {
    const trip = await tx
      .insertInto('trips')
      .values({
        tenant_id: user.tid,
        region_id: vehicle.region_id,
        started_at: new Date(),
        created_by: user.sub,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const assignment = await newAssignment(tx, user.tid, vehicle.id, input.driverId);
    await recordEvent(tx, {
      tenantId: user.tid,
      entity: 'trip',
      entityId: trip.id,
      type: 'trip.created',
      actorId: user.sub,
    });
    let assignmentId = assignment;
    for (const [i, leg] of input.legs.entries()) {
      if (leg.driverId && leg.driverId !== input.driverId) {
        assignmentId = await newAssignment(tx, user.tid, vehicle.id, leg.driverId);
      }
      await insertLeg(tx, user, trip.id, vehicle.region_id, i + 1, assignmentId, leg, i === 0);
    }
    return { id: trip.id };
  });
}

/** Appends a leg to an open trip — this is how a one-way trip becomes a round trip, even mid-way. */
export async function appendLeg(db: Db, user: AuthUser, tripId: string, leg: LegInput) {
  return db.transaction().execute(async (tx) => {
    const trip = await tx
      .selectFrom('trips')
      .selectAll()
      .where('tenant_id', '=', user.tid)
      .where('id', '=', tripId)
      .executeTakeFirst();
    if (!trip) throw notFound('Trip');
    if (trip.status !== 'active') throw badRequest('Trip is already closed');

    const last = await tx
      .selectFrom('legs')
      .innerJoin('assignments as a', 'a.id', 'legs.assignment_id')
      .select([
        'legs.seq',
        'legs.assignment_id',
        'legs.to_location_id',
        'a.vehicle_id',
        'a.driver_id',
      ])
      .where('legs.trip_id', '=', tripId)
      .orderBy('legs.seq', 'desc')
      .executeTakeFirstOrThrow();
    if (leg.fromLocationId !== last.to_location_id) {
      throw badRequest('New leg must start where the previous leg ends');
    }
    const assignmentId =
      leg.driverId && leg.driverId !== last.driver_id
        ? await newAssignment(tx, user.tid, last.vehicle_id, leg.driverId)
        : last.assignment_id;

    const openLeg = await tx
      .selectFrom('legs')
      .select('id')
      .where('trip_id', '=', tripId)
      .where('status', 'in', ['planned', 'active'])
      .executeTakeFirst();
    const id = await insertLeg(
      tx,
      user,
      tripId,
      trip.region_id,
      last.seq + 1,
      assignmentId,
      leg,
      !openLeg,
    );
    await recordEvent(tx, {
      tenantId: user.tid,
      entity: 'trip',
      entityId: tripId,
      type: 'trip.leg_appended',
      actorId: user.sub,
      payload: { legId: id, seq: last.seq + 1 },
    });
    return { id };
  });
}

async function newAssignment(db: Db, tenantId: string, vehicleId: string, driverId: string) {
  const driver = await db
    .selectFrom('drivers')
    .select(['id', 'status'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', driverId)
    .executeTakeFirst();
  if (!driver) throw notFound('Driver');
  if (driver.status !== 'active') throw badRequest('Driver is not active');
  const a = await db
    .insertInto('assignments')
    .values({ tenant_id: tenantId, vehicle_id: vehicleId, driver_id: driverId })
    .returning('id')
    .executeTakeFirstOrThrow();
  return a.id;
}

async function insertLeg(
  db: Db,
  user: AuthUser,
  tripId: string,
  regionId: string,
  seq: number,
  assignmentId: string,
  input: LegInput,
  activate: boolean,
): Promise<string> {
  const moves = input.moveIds.length
    ? await db
        .selectFrom('moves as m')
        .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
        .innerJoin('cargo_types as ct', 'ct.id', 'c.cargo_type_id')
        .innerJoin('job_types as jt', 'jt.id', 'm.job_type_id')
        .select([
          'm.id',
          'm.status',
          'm.client_id',
          'm.from_location_id',
          'm.to_location_id',
          'ct.uses',
          'jt.workflow_key',
        ])
        .where('m.tenant_id', '=', user.tid)
        .where('m.id', 'in', input.moveIds)
        .execute()
    : [];
  if (moves.length !== input.moveIds.length) throw notFound('Move');
  for (const m of moves) {
    if (m.status !== 'pending') throw badRequest('Move is already planned or closed');
    if (m.from_location_id !== input.fromLocationId || m.to_location_id !== input.toLocationId) {
      throw badRequest("A move's pickup and drop must match the leg's from and to");
    }
  }
  const workflowKeys = new Set(moves.map((m) => m.workflow_key));
  if (workflowKeys.size > 1) throw badRequest('Moves on one leg must share the same job type');

  // Capacity: what the vehicle can carry vs what this leg loads.
  const vehicle = await db
    .selectFrom('assignments as a')
    .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .innerJoin('vehicle_categories as vc', 'vc.id', 'v.category_id')
    .select(['vc.capacity'])
    .where('a.id', '=', assignmentId)
    .executeTakeFirstOrThrow();
  const cap = checkCapacity(
    vehicle.capacity,
    [],
    moves.map((m) => m.uses),
  );
  if (!cap.ok) throw badRequest(`Does not fit on this vehicle: ${cap.reason}`);

  const clientIds = [...new Set(moves.map((m) => m.client_id))];
  const { definitionId, flow } = await resolveWorkflow(db, {
    key: moves[0]?.workflow_key ?? EMPTY_FLOW_KEY,
    tenantId: user.tid,
    regionId,
    clientId: clientIds.length === 1 ? (clientIds[0] ?? null) : null,
  });

  const leg = await db
    .insertInto('legs')
    .values({
      tenant_id: user.tid,
      trip_id: tripId,
      seq,
      assignment_id: assignmentId,
      from_location_id: input.fromLocationId,
      to_location_id: input.toLocationId,
      kind: moves.length ? 'loaded' : 'empty',
      status: activate ? 'active' : 'planned',
      started_at: activate ? new Date() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const process = await db
    .insertInto('process_instances')
    .values({
      tenant_id: user.tid,
      entity: 'leg',
      entity_id: leg.id,
      definition_id: definitionId,
      current_step: flow.initialStep,
      status: activate ? 'active' : 'pending',
      step_entered_at: activate ? new Date() : null,
      started_at: activate ? new Date() : null,
      captured: json({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .updateTable('legs')
    .set({ process_instance_id: process.id })
    .where('id', '=', leg.id)
    .execute();

  if (moves.length) {
    await db
      .insertInto('leg_moves')
      .values(moves.map((m) => ({ leg_id: leg.id, move_id: m.id })))
      .execute();
    await db
      .updateTable('moves')
      .set({ status: 'planned' })
      .where(
        'id',
        'in',
        moves.map((m) => m.id),
      )
      .execute();
    // Shadow mode: compare the manager's choice with what the engine suggested.
    const chosen = await db
      .selectFrom('assignments')
      .select('vehicle_id')
      .where('id', '=', assignmentId)
      .executeTakeFirstOrThrow();
    for (const m of moves) await recordChoice(db, m.id, chosen.vehicle_id);
    // Pre-LR: one per client on this leg (one LR = one client + one vehicle + one leg).
    for (const clientId of clientIds) {
      const lr = await db
        .insertInto('lrs')
        .values({
          tenant_id: user.tid,
          region_id: regionId,
          client_id: clientId,
          leg_id: leg.id,
          charges: json([]),
          custom: json({}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const clientMoves = moves.filter((m) => m.client_id === clientId);
      await db
        .insertInto('lr_moves')
        .values(clientMoves.map((m) => ({ lr_id: lr.id, move_id: m.id })))
        .execute();
      await recordEvent(db, {
        tenantId: user.tid,
        entity: 'lr',
        entityId: lr.id,
        type: 'lr.pre_lr_created',
        actorId: user.sub,
      });
    }
  }
  await recordEvent(db, {
    tenantId: user.tid,
    entity: 'leg',
    entityId: leg.id,
    type: 'leg.created',
    actorId: user.sub,
    payload: {
      tripId,
      seq,
      kind: moves.length ? 'loaded' : 'empty',
      flow: `${flow.key}@v${flow.version}`,
    },
  });
  return leg.id;
}

// ─── Leg context, screen and actions ────────────────────────────────────────

async function loadLeg(db: Db, tenantId: string, legId: string) {
  const leg = await db
    .selectFrom('legs as l')
    .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
    .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .innerJoin('drivers as d', 'd.id', 'a.driver_id')
    .innerJoin('locations as lf', 'lf.id', 'l.from_location_id')
    .innerJoin('locations as lt', 'lt.id', 'l.to_location_id')
    .select([
      'l.id',
      'l.trip_id',
      'l.seq',
      'l.kind',
      'l.status',
      'l.process_instance_id',
      'a.driver_id',
      'v.id as vehicle_id',
      'v.reg_no',
      'v.last_odometer_km',
      'v.last_soc_pct',
      'd.name as driver_name',
      'lf.name as from_name',
      'lf.lat as from_lat',
      'lf.lng as from_lng',
      'lt.name as to_name',
      'lt.lat as to_lat',
      'lt.lng as to_lng',
    ])
    .where('l.tenant_id', '=', tenantId)
    .where('l.id', '=', legId)
    .executeTakeFirst();
  if (!leg?.process_instance_id) throw notFound('Leg');

  const process = await db
    .selectFrom('process_instances')
    .selectAll()
    .where('id', '=', leg.process_instance_id)
    .executeTakeFirstOrThrow();
  const flow = await getFlow(db, process.definition_id);

  const cargo = await db
    .selectFrom('leg_moves as lm')
    .innerJoin('moves as m', 'm.id', 'lm.move_id')
    .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
    .innerJoin('cargo_types as ct', 'ct.id', 'c.cargo_type_id')
    .innerJoin('clients as cl', 'cl.id', 'm.client_id')
    .select([
      'm.id as move_id',
      'c.identifier',
      'ct.attributes',
      'cl.code as client_code',
      'cl.name as client_name',
    ])
    .where('lm.leg_id', '=', legId)
    .execute();

  return { leg, process, flow, cargo };
}

type LoadedLeg = Awaited<ReturnType<typeof loadLeg>>;

function contextFor({ leg, process, cargo }: LoadedLeg): StepContext {
  const first = cargo[0];
  const fields: Record<string, unknown> = {};
  for (const stepValues of Object.values(process.captured)) Object.assign(fields, stepValues);
  return {
    cargo: first
      ? { ...(first.attributes as object), number: first.identifier, count: cargo.length }
      : {},
    client: first ? { code: first.client_code } : {},
    vehicle: { lastOdometer: num(leg.last_odometer_km), soc: num(leg.last_soc_pct) },
    leg: { kind: leg.kind, seq: leg.seq },
    fields,
  };
}

function screenFor(loaded: LoadedLeg, lang: string): Screen | null {
  const { leg, process, flow, cargo } = loaded;
  if (process.status !== 'active' || !process.current_step) return null;
  const step = findStep(flow, process.current_step);
  const info: Record<string, string> = {
    route: `${leg.from_name} → ${leg.to_name}`,
    vehicle: leg.reg_no,
  };
  if (cargo.length) {
    info.containers = cargo
      .map((c) => `${c.identifier} (${(c.attributes as { size?: string }).size ?? ''})`)
      .join(', ');
    info.client = [...new Set(cargo.map((c) => c.client_name))].join(', ');
  }
  const target =
    step.geoCheck?.location === 'from' ? [leg.from_lat, leg.from_lng] : [leg.to_lat, leg.to_lng];
  const [lat, lng] = target;
  return buildScreen({
    step,
    ctx: contextFor(loaded),
    lang,
    info,
    values: process.captured[step.key],
    ...(lat !== null && lng !== null && lat !== undefined && lng !== undefined
      ? { geo: { lat, lng } }
      : {}),
  });
}

function assertCanAct(user: AuthUser, actor: 'driver' | 'manager', driverId: string, lang: string) {
  if (actor === 'manager' && !isStaff(user)) throw forbidden(msg('managerStep', lang));
  if (actor === 'driver' && !isStaff(user) && user.driverId !== driverId) {
    throw forbidden(msg('otherDriver', lang));
  }
}

export async function getLegScreen(db: Db, user: AuthUser, legId: string, lang: string) {
  const loaded = await loadLeg(db, user.tid, legId);
  if (!isStaff(user) && user.driverId !== loaded.leg.driver_id) throw forbidden();
  return { legStatus: loaded.leg.status, screen: screenFor(loaded, lang) };
}

export async function actOnLeg(
  db: Db,
  user: AuthUser,
  legId: string,
  action: string,
  values: Record<string, unknown>,
  lang: string,
) {
  return db.transaction().execute(async (tx) => {
    const loaded = await loadLeg(tx, user.tid, legId);
    const { leg, process, flow } = loaded;
    if (leg.status !== 'active' || process.status !== 'active' || !process.current_step) {
      throw new AppError(409, msg('legNotActive', lang));
    }
    const step = findStep(flow, process.current_step);
    assertCanAct(user, step.actor, leg.driver_id, lang);

    const result = performAction(flow, step.key, action, contextFor(loaded), values, lang);
    if (!result.ok) throw new AppError(422, msg('fixFields', lang), result.errors);

    // Evidence must be a file this company uploaded (keys are "<tenantId>/<uuid>.<ext>").
    const badFiles = step.fields
      .filter((f) => f.type === 'photo' || f.type === 'document' || f.type === 'signature')
      .filter((f) => {
        const v = values[f.key];
        return (
          v !== undefined &&
          v !== null &&
          v !== '' &&
          !(typeof v === 'string' && v.startsWith(`${user.tid}/`))
        );
      })
      .map((f) => ({ field: f.key, message: msg('invalidFile', lang) }));
    if (badFiles.length) throw new AppError(422, msg('fixFields', lang), badFiles);

    // Keep only configured fields; store them on the process and as evidence.
    const accepted: Record<string, unknown> = {};
    for (const f of step.fields) if (values[f.key] !== undefined) accepted[f.key] = values[f.key];
    const captured = { ...process.captured, [step.key]: accepted };

    for (const f of step.fields) {
      const v = accepted[f.key];
      if (v === undefined || v === null || v === '') continue;
      const isFile = f.type === 'photo' || f.type === 'document' || f.type === 'signature';
      await tx
        .insertInto('evidence')
        .values({
          tenant_id: user.tid,
          process_instance_id: process.id,
          step_key: step.key,
          field_key: f.key,
          kind: isFile
            ? (f.type as 'photo' | 'document' | 'signature')
            : f.type === 'number'
              ? 'reading'
              : 'text',
          doc_type: f.docType ?? null,
          file_key: isFile ? String(v) : null,
          value: isFile ? null : json(v),
          // Documents/photos the flow wants AI to read are queued for the background reader.
          ai_result: await aiRequest(tx, user.tid, f, isFile),
          captured_by: user.sub,
        })
        .execute();
      // Live world model: readings bound to the vehicle update it immediately.
      if (f.bind === 'vehicle.odometer') {
        await tx
          .updateTable('vehicles')
          .set({ last_odometer_km: Number(v) })
          .where('id', '=', leg.vehicle_id)
          .execute();
      }
      if (f.bind === 'vehicle.soc') {
        await tx
          .updateTable('vehicles')
          .set({ last_soc_pct: Number(v) })
          .where('id', '=', leg.vehicle_id)
          .execute();
      }
    }

    for (const a of result.automations) {
      if (a.type === 'lr.issue') await issueLrs(tx, user, leg.id);
      else if (a.type === 'lr.close') await closeLrs(tx, user, leg.id);
      else {
        await recordEvent(tx, {
          tenantId: user.tid,
          entity: 'leg',
          entityId: leg.id,
          type: `automation.${a.type}`,
          actorId: user.sub,
          payload: { target: a.target, step: step.key },
        });
      }
    }

    const finished = result.nextStep === 'end';
    await tx
      .updateTable('process_instances')
      .set({
        captured: json(captured),
        current_step: finished ? null : result.nextStep,
        ...(result.nextStep !== step.key ? { step_entered_at: new Date() } : {}),
        status: finished ? 'completed' : 'active',
        ...(finished ? { ended_at: new Date() } : {}),
      })
      .where('id', '=', process.id)
      .execute();
    await recordEvent(tx, {
      tenantId: user.tid,
      entity: 'leg',
      entityId: leg.id,
      type: 'leg.step_completed',
      actorId: user.sub,
      payload: { step: step.key, action, next: result.nextStep },
    });

    if (!finished && loaded.cargo.length && step.key === flow.initialStep) {
      await tx
        .updateTable('moves')
        .set({ status: 'in_progress' })
        .where(
          'id',
          'in',
          loaded.cargo.map((c) => c.move_id),
        )
        .execute();
    }
    if (finished)
      await completeLeg(
        tx,
        user,
        leg.id,
        leg.trip_id,
        loaded.cargo.map((c) => c.move_id),
      );

    const next = await loadLeg(tx, user.tid, legId);
    return { legStatus: next.leg.status, screen: screenFor(next, lang) };
  });
}

async function completeLeg(
  db: Db,
  user: AuthUser,
  legId: string,
  tripId: string,
  moveIds: string[],
) {
  await db
    .updateTable('legs')
    .set({ status: 'completed', ended_at: new Date() })
    .where('id', '=', legId)
    .execute();
  if (moveIds.length)
    await db.updateTable('moves').set({ status: 'completed' }).where('id', 'in', moveIds).execute();
  await recordEvent(db, {
    tenantId: user.tid,
    entity: 'leg',
    entityId: legId,
    type: 'leg.completed',
    actorId: user.sub,
  });

  const next = await db
    .selectFrom('legs')
    .select(['id', 'process_instance_id'])
    .where('trip_id', '=', tripId)
    .where('status', '=', 'planned')
    .orderBy('seq')
    .executeTakeFirst();
  if (next) {
    await db
      .updateTable('legs')
      .set({ status: 'active', started_at: new Date() })
      .where('id', '=', next.id)
      .execute();
    if (next.process_instance_id) {
      await db
        .updateTable('process_instances')
        .set({ status: 'active', started_at: new Date(), step_entered_at: new Date() })
        .where('id', '=', next.process_instance_id)
        .execute();
    }
    return;
  }
  await db
    .updateTable('trips')
    .set({ status: 'completed', ended_at: new Date() })
    .where('id', '=', tripId)
    .execute();
  await recordEvent(db, {
    tenantId: user.tid,
    entity: 'trip',
    entityId: tripId,
    type: 'trip.completed',
    actorId: user.sub,
  });
}

// ─── LR ─────────────────────────────────────────────────────────────────────

async function nextLrNumber(db: Db, tenantId: string, prefix: string): Promise<string> {
  const row = await db
    .insertInto('lr_sequences')
    .values({ tenant_id: tenantId, prefix, next_value: 2 })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'prefix'])
        .doUpdateSet((eb) => ({ next_value: eb('lr_sequences.next_value', '+', 1) })),
    )
    .returning('next_value')
    .executeTakeFirstOrThrow();
  return `${prefix}${String(row.next_value - 1).padStart(6, '0')}`;
}

async function issueLrs(db: Db, user: AuthUser, legId: string) {
  const pending = await db
    .selectFrom('lrs')
    .innerJoin('clients as c', 'c.id', 'lrs.client_id')
    .select(['lrs.id', 'c.billing', 'c.code'])
    .where('lrs.leg_id', '=', legId)
    .where('lrs.status', '=', 'pre_lr')
    .execute();
  if (pending.length) {
    // A move may be created before its container number is known; the LR cannot be.
    const unnumbered = await db
      .selectFrom('lr_moves as lm')
      .innerJoin('moves as m', 'm.id', 'lm.move_id')
      .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
      .select('m.id')
      .where(
        'lm.lr_id',
        'in',
        pending.map((p) => p.id),
      )
      .where('c.identifier', 'is', null)
      .execute();
    if (unnumbered.length) {
      throw badRequest(
        `Container number missing on ${unnumbered.length} move(s) — the manager must add it before the LR is issued`,
      );
    }
  }
  for (const lr of pending) {
    // Number series comes from client config (billing.lrPrefix), never from code.
    const prefix = (lr.billing as { lrPrefix?: string }).lrPrefix ?? `LR-${lr.code}-`;
    const number = await nextLrNumber(db, user.tid, prefix);
    await db
      .updateTable('lrs')
      .set({ status: 'issued', number, issued_at: new Date() })
      .where('id', '=', lr.id)
      .execute();
    await recordEvent(db, {
      tenantId: user.tid,
      entity: 'lr',
      entityId: lr.id,
      type: 'lr.issued',
      actorId: user.sub,
      payload: { number },
    });
  }
}

async function closeLrs(db: Db, user: AuthUser, legId: string) {
  const issued = await db
    .selectFrom('lrs')
    .select('id')
    .where('leg_id', '=', legId)
    .where('status', '=', 'issued')
    .execute();
  for (const lr of issued) {
    await db
      .updateTable('lrs')
      .set({ status: 'closed', closed_at: new Date() })
      .where('id', '=', lr.id)
      .execute();
    await recordEvent(db, {
      tenantId: user.tid,
      entity: 'lr',
      entityId: lr.id,
      type: 'lr.closed',
      actorId: user.sub,
    });
    // Price it from the client's rate card (and auto-approve if policy allows).
    await priceClosedLr(db, user, lr.id);
  }
}

export async function listLrs(db: Db, tenantId: string) {
  return db
    .selectFrom('lrs')
    .innerJoin('clients as c', 'c.id', 'lrs.client_id')
    .innerJoin('legs as l', 'l.id', 'lrs.leg_id')
    .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
    .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .select([
      'lrs.id',
      'lrs.number',
      'lrs.status',
      'lrs.created_at as createdAt',
      'lrs.issued_at as issuedAt',
      'lrs.closed_at as closedAt',
      'lrs.total_amount as total',
      'lrs.netsuite_ref as netsuiteRef',
      'c.name as clientName',
      'v.reg_no as vehicleRegNo',
      'l.trip_id as tripId',
      'l.seq as legSeq',
    ])
    .where('lrs.tenant_id', '=', tenantId)
    .orderBy('lrs.created_at', 'desc')
    .execute();
}

// ─── Board (mission control) ────────────────────────────────────────────────

export async function tripBoard(
  db: Db,
  user: AuthUser,
  opts: { status?: string; tripId?: string; driverId?: string },
) {
  let q = db
    .selectFrom('legs as l')
    .innerJoin('trips as t', 't.id', 'l.trip_id')
    .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
    .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .innerJoin('drivers as d', 'd.id', 'a.driver_id')
    .innerJoin('locations as lf', 'lf.id', 'l.from_location_id')
    .innerJoin('locations as lt', 'lt.id', 'l.to_location_id')
    .innerJoin('location_types as ltf', 'ltf.id', 'lf.location_type_id')
    .innerJoin('location_types as ltt', 'ltt.id', 'lt.location_type_id')
    .leftJoin('process_instances as p', 'p.id', 'l.process_instance_id')
    .select([
      'lf.lat as fromLat',
      'lf.lng as fromLng',
      'lf.charging as fromCharging',
      'ltf.code as fromType',
      'lt.lat as toLat',
      'lt.lng as toLng',
      'lt.charging as toCharging',
      'ltt.code as toType',
      'p.step_entered_at as stepEnteredAt',
      'p.captured',
      'v.last_seen_at as lastSeenAt',
      't.id as tripId',
      't.status as tripStatus',
      't.created_at as tripCreatedAt',
      'l.id',
      'l.seq',
      'l.kind',
      'l.status',
      'l.started_at as startedAt',
      'l.ended_at as endedAt',
      'v.id as vehicleId',
      'v.reg_no as vehicleRegNo',
      'v.last_soc_pct as soc',
      'v.last_odometer_km as odometer',
      'd.id as driverId',
      'd.name as driverName',
      'lf.id as fromId',
      'lf.name as fromName',
      'lt.id as toId',
      'lt.name as toName',
      'p.current_step as currentStep',
      'p.definition_id as definitionId',
    ])
    .where('l.tenant_id', '=', user.tid)
    .orderBy('t.created_at', 'desc')
    .orderBy('l.seq');
  if (opts.status) q = q.where('t.status', '=', opts.status as never);
  if (opts.tripId) q = q.where('t.id', '=', opts.tripId);
  if (opts.driverId) q = q.where('d.id', '=', opts.driverId);
  const legs = await q.execute();
  if (!legs.length) return [];

  const legIds = legs.map((l) => l.id);
  const [cargo, lrs] = await Promise.all([
    db
      .selectFrom('leg_moves as lm')
      .innerJoin('moves as m', 'm.id', 'lm.move_id')
      .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
      .innerJoin('cargo_types as ct', 'ct.id', 'c.cargo_type_id')
      .innerJoin('clients as cl', 'cl.id', 'm.client_id')
      .select(['lm.leg_id', 'c.identifier', 'ct.attributes', 'cl.name as client'])
      .where('lm.leg_id', 'in', legIds)
      .execute(),
    db
      .selectFrom('lrs')
      .innerJoin('clients as cl', 'cl.id', 'lrs.client_id')
      .select(['lrs.id', 'lrs.leg_id', 'lrs.number', 'lrs.status', 'cl.name as client'])
      .where('lrs.leg_id', 'in', legIds)
      .execute(),
  ]);

  const flows = new Map<string, FlowDefinition>();
  for (const id of new Set(legs.map((l) => l.definitionId).filter((x): x is string => !!x))) {
    flows.set(id, await getFlow(db, id));
  }

  const trips = new Map<string, { id: string; status: string; createdAt: Date; legs: unknown[] }>();
  for (const l of legs) {
    const flow = l.definitionId ? flows.get(l.definitionId) : undefined;
    const steps =
      flow?.steps.map((s) => ({
        key: s.key,
        title: localize(s.title, user.lang),
        actor: s.actor,
        /** Where the step happens: at the pickup, at the drop, or not tied to a place. */
        at: s.geoCheck?.location ?? null,
        slaMinutes: s.sla?.maxMinutes ?? null,
        /** Evidence this step asks for, and which of it has been captured. */
        evidence: s.fields
          .filter(
            (f) => f.type === 'photo' || f.type === 'document' || f.type === 'signature' || f.bind,
          )
          .map((f) => ({
            key: f.key,
            label: localize(f.label, user.lang),
            done:
              (l.captured as Record<string, Record<string, unknown>> | null)?.[s.key]?.[f.key] !=
              null,
          })),
      })) ?? [];
    const position = flow
      ? l.status === 'completed'
        ? steps.length + 1
        : stepPosition(flow, l.currentStep)
      : 0;
    const trip = trips.get(l.tripId) ?? {
      id: l.tripId,
      status: l.tripStatus,
      createdAt: l.tripCreatedAt,
      legs: [],
    };
    trip.legs.push({
      id: l.id,
      seq: l.seq,
      kind: l.kind,
      status: l.status,
      startedAt: l.startedAt,
      endedAt: l.endedAt,
      vehicle: {
        id: l.vehicleId,
        regNo: l.vehicleRegNo,
        soc: num(l.soc),
        odometer: num(l.odometer),
      },
      driver: { id: l.driverId, name: l.driverName },
      from: {
        id: l.fromId,
        name: l.fromName,
        type: l.fromType,
        lat: l.fromLat,
        lng: l.fromLng,
        charging: !!(l.fromCharging as { available?: boolean }).available,
      },
      to: {
        id: l.toId,
        name: l.toName,
        type: l.toType,
        lat: l.toLat,
        lng: l.toLng,
        charging: !!(l.toCharging as { available?: boolean }).available,
      },
      flow: flow ? { key: flow.key, version: flow.version, name: flow.name } : null,
      steps,
      currentStep: l.currentStep,
      stepEnteredAt: l.stepEnteredAt,
      lastSeenAt: l.lastSeenAt,
      position,
      containers: cargo
        .filter((c) => c.leg_id === l.id)
        .map((c) => ({
          number: c.identifier,
          size: (c.attributes as { size?: string }).size ?? '',
          client: c.client,
        })),
      lrs: lrs.filter((r) => r.leg_id === l.id).map(({ leg_id: _, ...r }) => r),
    });
    trips.set(l.tripId, trip);
  }
  return [...trips.values()];
}

/** Legs waiting on a manager — the start of the exception/task queue. */
export async function managerTasks(db: Db, user: AuthUser) {
  const board = await tripBoard(db, user, { status: 'active' });
  type BoardLeg = {
    status: string;
    currentStep: string | null;
    steps: { key: string; title: string; actor: string }[];
  };
  return board.flatMap((t) =>
    (t.legs as (BoardLeg & Record<string, unknown>)[])
      .filter(
        (l) =>
          l.status === 'active' &&
          l.steps.find((s) => s.key === l.currentStep)?.actor === 'manager',
      )
      .map((l) => ({
        tripId: t.id,
        leg: l,
        task: l.steps.find((s) => s.key === l.currentStep)?.title,
      })),
  );
}

export async function tripEvents(db: Db, tenantId: string, tripId: string) {
  const legIds = (
    await db.selectFrom('legs').select('id').where('trip_id', '=', tripId).execute()
  ).map((l) => l.id);
  return db
    .selectFrom('events')
    .leftJoin('users as u', 'u.id', 'events.actor_id')
    .select([
      'events.id',
      'events.entity',
      'events.type',
      'events.payload',
      'events.created_at as at',
      'u.name as actor',
    ])
    .where('events.tenant_id', '=', tenantId)
    .where((eb) =>
      eb.or([
        eb('events.entity_id', '=', tripId),
        ...(legIds.length ? [eb('events.entity_id', 'in', legIds)] : []),
      ]),
    )
    .orderBy('events.id', 'desc')
    .limit(200)
    .execute();
}

async function aiRequest(
  db: Db,
  tenantId: string,
  field: StepDef['fields'][number],
  isFile: boolean,
) {
  if (!isFile) return null;
  const template = await templateForField(db, tenantId, field);
  return template ? json({ status: 'pending', template }) : null;
}

import type { FlowDefinition } from '@vms/contracts';
import { sql } from 'kysely';
import type { Db } from '../../db/client';
import {
  type FleetSlot,
  type MoveToPlace,
  type Point,
  straightKm,
  suggestVehicles,
} from '../../domain/dispatch';
import { json, num } from '../../lib/db-utils';
import { badRequest, notFound } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import type { AuthUser } from '../../plugins/auth';
import { appendLeg, createTrip } from '../operations/service';

/**
 * The live "mini world": for every truck, where it is, where/when it becomes free and with
 * how much battery. Built from legs, flow progress, GPS pings and readings.
 */
export interface VehicleState extends FleetSlot {
  status: string;
  soc: number | null;
  position: Point | null;
  positionSource: 'gps' | 'leg' | 'last_place' | 'none';
  activeLeg: {
    id: string;
    tripId: string;
    from: string;
    to: string;
    step: string | null;
    progress: number;
  } | null;
}

const DEFAULT_LEG_DWELL_MIN = 60;

export async function fleetState(
  db: Db,
  tenantId: string,
  now = new Date(),
): Promise<VehicleState[]> {
  const s = (await getSettings(db, tenantId)).dispatch;
  const road = (a: Point, b: Point) => straightKm(a, b) * s.roadFactor;
  const travelMin = (km: number) => (km / s.avgSpeedKmh) * 60;

  const vehicles = await db
    .selectFrom('vehicles as v')
    .innerJoin('vehicle_categories as vc', 'vc.id', 'v.category_id')
    .select([
      'v.id',
      'v.reg_no',
      'v.status',
      'v.battery_kwh',
      'v.last_soc_pct',
      'v.last_lat',
      'v.last_lng',
      'v.last_seen_at',
      'vc.capacity',
    ])
    .where('v.tenant_id', '=', tenantId)
    .execute();

  const openLegs = await db
    .selectFrom('legs as l')
    .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
    .innerJoin('drivers as d', 'd.id', 'a.driver_id')
    .innerJoin('locations as lf', 'lf.id', 'l.from_location_id')
    .innerJoin('locations as lt', 'lt.id', 'l.to_location_id')
    .leftJoin('process_instances as p', 'p.id', 'l.process_instance_id')
    .select([
      'l.id',
      'l.trip_id',
      'l.seq',
      'l.kind',
      'l.status',
      'a.vehicle_id',
      'd.id as driverId',
      'd.name as driverName',
      'lf.id as fromId',
      'lf.name as fromName',
      'lf.lat as fromLat',
      'lf.lng as fromLng',
      'lt.id as toId',
      'lt.name as toName',
      'lt.lat as toLat',
      'lt.lng as toLng',
      'p.current_step',
      'p.definition_id',
    ])
    .where('l.tenant_id', '=', tenantId)
    .where('l.status', 'in', ['active', 'planned'])
    .orderBy('l.trip_id')
    .orderBy('l.seq')
    .execute();

  // Where each idle truck last finished.
  const lastDone = await db
    .selectFrom('legs as l')
    .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
    .innerJoin('locations as lt', 'lt.id', 'l.to_location_id')
    .select([
      'a.vehicle_id',
      'a.driver_id',
      'lt.id as placeId',
      'lt.name',
      'lt.lat',
      'lt.lng',
      'l.ended_at',
    ])
    .where('l.tenant_id', '=', tenantId)
    .where('l.status', '=', 'completed')
    .orderBy('l.ended_at', 'desc')
    .execute();

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const legsToday = await db
    .selectFrom('legs as l')
    .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
    .select(['a.vehicle_id', sql<number>`count(*)::int`.as('n')])
    .where('l.tenant_id', '=', tenantId)
    .where('l.started_at', '>=', today)
    .groupBy('a.vehicle_id')
    .execute();

  // Expired documents block dispatch.
  const todayIso = now.toISOString().slice(0, 10);
  const expired = await db
    .selectFrom('entity_documents')
    .select(['entity', 'entity_id', 'doc_type', 'expires_at'])
    .where('tenant_id', '=', tenantId)
    .where('expires_at', '<', todayIso)
    .execute();
  const blockersOf = (entity: 'driver' | 'vehicle', id: string | null) =>
    expired
      .filter((d) => d.entity === entity && d.entity_id === id)
      .map(
        (d) =>
          `${entity === 'driver' ? 'Driver' : 'Truck'} ${d.doc_type.replace(/_/g, ' ')} expired`,
      );

  // Free drivers for idle trucks: last driver of that truck first, else any active driver not on a trip.
  const busyDrivers = new Set(openLegs.map((l) => l.driverId));
  const drivers = await db
    .selectFrom('drivers')
    .select(['id', 'name', 'status'])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .orderBy('name')
    .execute();
  // Drivers with an expired licence/port pass are never offered for a new trip.
  const freeDrivers = drivers.filter(
    (d) => !busyDrivers.has(d.id) && blockersOf('driver', d.id).length === 0,
  );

  const flows = new Map<string, FlowDefinition>();
  for (const id of new Set(openLegs.map((l) => l.definition_id).filter((x): x is string => !!x))) {
    const row = await db
      .selectFrom('config_definitions')
      .select('body')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    flows.set(id, row.body as FlowDefinition);
  }

  const out: VehicleState[] = [];
  for (const v of vehicles) {
    const legs = openLegs.filter((l) => l.vehicle_id === v.id);
    const soc = num(v.last_soc_pct);
    const battery = num(v.battery_kwh) ?? 0;
    const blockers = [...blockersOf('vehicle', v.id)];
    if (v.status !== 'active') blockers.push(`Truck in ${v.status}`);
    const gps =
      v.last_lat !== null &&
      v.last_lng !== null &&
      v.last_seen_at &&
      now.getTime() - v.last_seen_at.getTime() < 30 * 60000
        ? { lat: v.last_lat, lng: v.last_lng }
        : null;

    if (legs.length) {
      // On a trip: walk the remaining legs to forecast when/where it is free.
      let t = now.getTime();
      let socLeft = soc;
      let activeLeg: VehicleState['activeLeg'] = null;
      for (const l of legs) {
        const from = { lat: l.fromLat ?? 0, lng: l.fromLng ?? 0 };
        const to = { lat: l.toLat ?? 0, lng: l.toLng ?? 0 };
        const km = road(from, to);
        const full = travelMin(km) + DEFAULT_LEG_DWELL_MIN;
        let remainingShare = 1;
        if (l.status === 'active') {
          const flow = l.definition_id ? flows.get(l.definition_id) : undefined;
          const idx = flow ? flow.steps.findIndex((x) => x.key === l.current_step) : 0;
          const progress = flow && idx >= 0 ? idx / flow.steps.length : 0;
          remainingShare = 1 - progress;
          activeLeg = {
            id: l.id,
            tripId: l.trip_id,
            from: l.fromName,
            to: l.toName,
            step: l.current_step,
            progress: Math.round(progress * 100),
          };
        }
        t += full * remainingShare * 60000;
        if (socLeft !== null && battery > 0) {
          socLeft -=
            ((km * remainingShare * (l.kind === 'loaded' ? s.kwhPerKmLoaded : s.kwhPerKmEmpty)) /
              battery) *
            100;
        }
      }
      const last = legs.at(-1);
      const first = legs[0];
      const legPos =
        activeLeg && first && activeLeg.progress < 50
          ? { lat: first.fromLat ?? 0, lng: first.fromLng ?? 0 }
          : first
            ? { lat: first.toLat ?? 0, lng: first.toLng ?? 0 }
            : null;
      out.push({
        vehicleId: v.id,
        regNo: v.reg_no,
        status: v.status,
        capacity: v.capacity,
        batteryKwh: battery,
        soc,
        freeAt: new Date(t),
        freeAt_place:
          last && last.toLat !== null && last.toLng !== null
            ? { id: last.toId, name: last.toName, lat: last.toLat, lng: last.toLng }
            : null,
        freeSocPct: socLeft === null ? null : Math.max(0, socLeft),
        driverId: last?.driverId ?? null,
        driverName: last?.driverName ?? null,
        tripId: last?.trip_id ?? null,
        endsEmpty: last?.kind === 'empty',
        legsToday: legsToday.find((x) => x.vehicle_id === v.id)?.n ?? 0,
        blockers: [...blockers, ...blockersOf('driver', last?.driverId ?? null)],
        position: gps ?? legPos,
        positionSource: gps ? 'gps' : legPos ? 'leg' : 'none',
        activeLeg,
      });
      continue;
    }

    // Idle: free now where it last finished (or last GPS fix).
    const done = lastDone.find((d) => d.vehicle_id === v.id);
    const preferred = done ? freeDrivers.find((d) => d.id === done.driver_id) : undefined;
    const driver = preferred ?? freeDrivers.shift();
    if (driver && preferred) freeDrivers.splice(freeDrivers.indexOf(preferred), 1);
    const place =
      done && done.lat !== null && done.lng !== null
        ? { id: done.placeId, name: done.name, lat: done.lat, lng: done.lng }
        : null;
    out.push({
      vehicleId: v.id,
      regNo: v.reg_no,
      status: v.status,
      capacity: v.capacity,
      batteryKwh: battery,
      soc,
      freeAt: now,
      freeAt_place: gps ? { ...gps, name: 'current location' } : place,
      freeSocPct: soc,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      tripId: null,
      endsEmpty: false,
      legsToday: legsToday.find((x) => x.vehicle_id === v.id)?.n ?? 0,
      blockers: [...blockers, ...(driver ? blockersOf('driver', driver.id) : ['No free driver'])],
      position: gps ?? place,
      positionSource: gps ? 'gps' : place ? 'last_place' : 'none',
      activeLeg: null,
    });
  }
  return out;
}

/** Idle trucks with no history start at the region's first charging hub (the depot). */
export async function withDepotFallback(db: Db, tenantId: string, fleet: VehicleState[]) {
  if (fleet.every((f) => f.freeAt_place)) return fleet;
  const hub = await db
    .selectFrom('locations')
    .select(['id', 'name', 'lat', 'lng'])
    .where('tenant_id', '=', tenantId)
    .where(sql<boolean>`(charging->>'available')::boolean = true`)
    .orderBy('code')
    .executeTakeFirst();
  if (!hub || hub.lat === null || hub.lng === null) return fleet;
  const p = { id: hub.id, name: hub.name, lat: hub.lat, lng: hub.lng };
  return fleet.map((f) =>
    f.freeAt_place
      ? f
      : {
          ...f,
          freeAt_place: p,
          position: f.position ?? p,
          positionSource: f.position ? f.positionSource : ('last_place' as const),
        },
  );
}

async function chargers(db: Db, tenantId: string): Promise<Point[]> {
  const rows = await db
    .selectFrom('locations')
    .select(['lat', 'lng'])
    .where('tenant_id', '=', tenantId)
    .where(sql<boolean>`(charging->>'available')::boolean = true`)
    .execute();
  return rows.filter((r) => r.lat !== null && r.lng !== null) as Point[];
}

async function loadMove(
  db: Db,
  tenantId: string,
  moveId: string,
): Promise<MoveToPlace & { status: string }> {
  const m = await db
    .selectFrom('moves as m')
    .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
    .innerJoin('cargo_types as ct', 'ct.id', 'c.cargo_type_id')
    .innerJoin('locations as lf', 'lf.id', 'm.from_location_id')
    .innerJoin('locations as lt', 'lt.id', 'm.to_location_id')
    .select([
      'm.id',
      'm.status',
      'm.cutoff_at',
      'c.identifier',
      'ct.uses',
      'lf.id as fId',
      'lf.name as fName',
      'lf.lat as fLat',
      'lf.lng as fLng',
      'lt.id as tId',
      'lt.name as tName',
      'lt.lat as tLat',
      'lt.lng as tLng',
    ])
    .where('m.tenant_id', '=', tenantId)
    .where('m.id', '=', moveId)
    .executeTakeFirst();
  if (!m) throw notFound('Move');
  if (m.fLat === null || m.fLng === null || m.tLat === null || m.tLng === null)
    throw badRequest('Pickup or drop place has no coordinates');
  return {
    id: m.id,
    status: m.status,
    container: m.identifier ?? '(number pending)',
    uses: m.uses,
    cutoffAt: m.cutoff_at,
    from: { id: m.fId, name: m.fName, lat: m.fLat, lng: m.fLng },
    to: { id: m.tId, name: m.tName, lat: m.tLat, lng: m.tLng },
  };
}

/** Top suggestions for one move; logged so we can measure them against the manager's choice. */
export async function suggestForMove(db: Db, tenantId: string, moveId: string, now = new Date()) {
  const move = await loadMove(db, tenantId, moveId);
  if (move.status !== 'pending') throw badRequest('Only a pending move needs a truck');
  const policy = (await getSettings(db, tenantId)).dispatch;
  const fleet = await withDepotFallback(db, tenantId, await fleetState(db, tenantId, now));
  const result = suggestVehicles(move, fleet, await chargers(db, tenantId), policy, now);
  const top = result.suggestions.slice(0, 5);
  const log = await db
    .insertInto('dispatch_suggestions')
    .values({
      tenant_id: tenantId,
      move_id: moveId,
      ranked: json(top.map((s) => ({ vehicleId: s.vehicleId, score: s.score, kind: s.kind }))),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { suggestionId: log.id, move, suggestions: top, rejected: result.rejected };
}

/** Shadow mode: when a manager plans a move, record which suggestion rank they picked (or none). */
export async function recordChoice(db: Db, moveId: string, vehicleId: string) {
  const last = await db
    .selectFrom('dispatch_suggestions')
    .select(['id', 'ranked'])
    .where('move_id', '=', moveId)
    .where('decided_at', 'is', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!last) return;
  const idx = (last.ranked as { vehicleId: string }[]).findIndex((r) => r.vehicleId === vehicleId);
  await db
    .updateTable('dispatch_suggestions')
    .set({
      chosen_vehicle_id: vehicleId,
      chosen_rank: idx >= 0 ? idx + 1 : null,
      decided_at: new Date(),
    })
    .where('id', '=', last.id)
    .execute();
}

/** One click: carry out a suggestion (new trip, or append a leg = round trip / diversion). */
export async function acceptSuggestion(db: Db, user: AuthUser, moveId: string, vehicleId: string) {
  const { move, suggestions } = await suggestForMove(db, user.tid, moveId);
  const s = suggestions.find((x) => x.vehicleId === vehicleId);
  if (!s) throw badRequest('That truck is no longer a valid option — refresh suggestions');
  if (!s.driverId) throw badRequest('No driver available for that truck');
  if (s.action === 'append_leg' && s.tripId) {
    // If the truck ends somewhere else, first add an empty leg to the pickup.
    const trip = await db
      .selectFrom('legs')
      .select(['to_location_id'])
      .where('trip_id', '=', s.tripId)
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow();
    if (trip.to_location_id !== move.from.id) {
      await appendLeg(db, user, s.tripId, {
        fromLocationId: trip.to_location_id,
        toLocationId: move.from.id,
        moveIds: [],
      });
    }
    await appendLeg(db, user, s.tripId, {
      fromLocationId: move.from.id,
      toLocationId: move.to.id,
      moveIds: [moveId],
    });
    return { tripId: s.tripId, action: s.action, kind: s.kind };
  }
  const fleet = await withDepotFallback(db, user.tid, await fleetState(db, user.tid));
  const here = fleet.find((f) => f.vehicleId === vehicleId)?.freeAt_place;
  const legs = [];
  if (here?.id && here.id !== move.from.id)
    legs.push({ fromLocationId: here.id, toLocationId: move.from.id, moveIds: [] });
  legs.push({ fromLocationId: move.from.id, toLocationId: move.to.id, moveIds: [moveId] });
  const trip = await createTrip(db, user, { vehicleId, driverId: s.driverId, legs });
  return { tripId: trip.id, action: s.action, kind: s.kind };
}

/** Round-trip opportunities: trucks finishing where pending moves start. */
export async function opportunities(db: Db, tenantId: string, now = new Date()) {
  const fleet = await fleetState(db, tenantId, now);
  const pending = await db
    .selectFrom('moves')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'pending')
    .execute();
  const out: {
    moveId: string;
    container: string;
    vehicleId: string;
    regNo: string;
    tripId: string;
    kind: string;
    score: number;
    reasons: string[];
  }[] = [];
  const policy = (await getSettings(db, tenantId)).dispatch;
  const ch = await chargers(db, tenantId);
  for (const p of pending) {
    const move = await loadMove(db, tenantId, p.id).catch(() => null);
    if (!move) continue;
    const onTrip = fleet.filter((f) => f.tripId);
    const best = suggestVehicles(move, onTrip, ch, policy, now).suggestions[0];
    if (best?.tripId && best.emptyKm < 5) {
      out.push({
        moveId: move.id,
        container: move.container,
        vehicleId: best.vehicleId,
        regNo: best.regNo,
        tripId: best.tripId,
        kind: best.kind,
        score: best.score,
        reasons: best.reasons,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function shadowReport(db: Db, tenantId: string) {
  const rows = await db
    .selectFrom('dispatch_suggestions')
    .select(['chosen_rank', 'decided_at'])
    .where('tenant_id', '=', tenantId)
    .where('decided_at', 'is not', null)
    .execute();
  const n = rows.length;
  const top1 = rows.filter((r) => r.chosen_rank === 1).length;
  const top3 = rows.filter((r) => r.chosen_rank !== null && r.chosen_rank <= 3).length;
  return {
    decisions: n,
    topPickRate: n ? Math.round((top1 / n) * 100) : null,
    top3Rate: n ? Math.round((top3 / n) * 100) : null,
    notSuggested: rows.filter((r) => r.chosen_rank === null).length,
  };
}

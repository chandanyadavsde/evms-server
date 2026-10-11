import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { sql } from 'kysely';
import { straightKm } from '../../domain/dispatch';
import { json, num, recordEvent } from '../../lib/db-utils';
import { badRequest, forbidden } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import {
  acceptSuggestion,
  fleetState,
  opportunities,
  shadowReport,
  suggestForMove,
  withDepotFallback,
} from './service';

const Id = Type.String({ format: 'uuid' });

export const dispatchRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const db = app.db;
  const staff = app.auth('admin', 'manager');

  // ── Smart dispatch ──
  app.get(
    '/v1/dispatch/moves/:id/suggestions',
    { preHandler: staff, schema: { params: Type.Object({ id: Id }) } },
    async (req) => suggestForMove(db, req.user.tid, req.params.id),
  );
  app.post(
    '/v1/dispatch/moves/:id/accept',
    {
      preHandler: staff,
      schema: { params: Type.Object({ id: Id }), body: Type.Object({ vehicleId: Id }) },
    },
    async (req, reply) =>
      reply.code(201).send(await acceptSuggestion(db, req.user, req.params.id, req.body.vehicleId)),
  );
  app.get('/v1/dispatch/opportunities', { preHandler: staff }, async (req) =>
    opportunities(db, req.user.tid),
  );
  app.get('/v1/dispatch/shadow-report', { preHandler: staff }, async (req) =>
    shadowReport(db, req.user.tid),
  );

  // ── Live world ──
  app.get('/v1/fleet/live', { preHandler: staff }, async (req) => {
    const [fleet, places] = await Promise.all([
      fleetState(db, req.user.tid).then((f) => withDepotFallback(db, req.user.tid, f)),
      db
        .selectFrom('locations as l')
        .innerJoin('location_types as t', 't.id', 'l.location_type_id')
        .select(['l.id', 'l.name', 'l.code', 'l.lat', 'l.lng', 'l.charging', 't.code as type'])
        .where('l.tenant_id', '=', req.user.tid)
        .execute(),
    ]);
    return { fleet, places, at: new Date() };
  });

  // ── Driver: location pings and shifts (phone GPS until telematics) ──
  app.post(
    '/v1/driver/location',
    {
      preHandler: app.auth(),
      schema: {
        body: Type.Object({
          lat: Type.Number({ minimum: -90, maximum: 90 }),
          lng: Type.Number({ minimum: -180, maximum: 180 }),
          speedKmh: Type.Optional(Type.Number({ minimum: 0 })),
          recordedAt: Type.Optional(Type.String()),
        }),
      },
    },
    async (req) => {
      if (!req.user.driverId) throw forbidden('Not a driver account');
      const leg = await db
        .selectFrom('legs as l')
        .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
        .select('a.vehicle_id')
        .where('a.driver_id', '=', req.user.driverId)
        .where('l.status', '=', 'active')
        .executeTakeFirst();
      const shift = await db
        .selectFrom('driver_shifts')
        .select('vehicle_id')
        .where('driver_id', '=', req.user.driverId)
        .where('ended_at', 'is', null)
        .executeTakeFirst();
      const vehicleId = leg?.vehicle_id ?? shift?.vehicle_id;
      if (!vehicleId) return { stored: false, reason: 'Not on duty with a truck' };
      const at = req.body.recordedAt ? new Date(req.body.recordedAt) : new Date();
      await db
        .insertInto('vehicle_positions')
        .values({
          tenant_id: req.user.tid,
          vehicle_id: vehicleId,
          driver_id: req.user.driverId,
          lat: req.body.lat,
          lng: req.body.lng,
          speed_kmh: req.body.speedKmh ?? null,
          recorded_at: at,
        })
        .execute();
      await db
        .updateTable('vehicles')
        .set({ last_lat: req.body.lat, last_lng: req.body.lng, last_seen_at: at })
        .where('id', '=', vehicleId)
        .execute();
      return { stored: true };
    },
  );

  /** Trucks a driver may start a shift on: their trip's truck if planned, otherwise active free trucks. */
  app.get('/v1/driver/trucks', { preHandler: app.auth() }, async (req) => {
    if (!req.user.driverId) throw forbidden('Not a driver account');
    const assigned = await db
      .selectFrom('legs as l')
      .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
      .select('a.vehicle_id')
      .where('a.driver_id', '=', req.user.driverId)
      .where('l.status', 'in', ['active', 'planned'])
      .executeTakeFirst();
    let q = db
      .selectFrom('vehicles')
      .select(['id', 'reg_no as regNo', 'last_odometer_km as odometer', 'last_soc_pct as soc'])
      .where('tenant_id', '=', req.user.tid)
      .where('status', '=', 'active');
    if (assigned) q = q.where('id', '=', assigned.vehicle_id);
    const rows = await q.orderBy('reg_no').execute();
    return rows.map((r) => ({
      ...r,
      odometer: num(r.odometer),
      soc: num(r.soc),
      assigned: !!assigned,
    }));
  });

  const Readings = Type.Object({
    odometer: Type.Number({ minimum: 0 }),
    soc: Type.Number({ minimum: 0, maximum: 100 }),
    photoKey: Type.Optional(Type.String()),
    checklistOk: Type.Optional(Type.Boolean()),
  });
  app.get('/v1/driver/shift', { preHandler: app.auth() }, async (req) => {
    if (!req.user.driverId) throw forbidden('Not a driver account');
    return (
      (await db
        .selectFrom('driver_shifts as s')
        .leftJoin('vehicles as v', 'v.id', 's.vehicle_id')
        .select(['s.id', 's.started_at', 's.start_readings', 'v.reg_no'])
        .where('s.driver_id', '=', req.user.driverId)
        .where('s.ended_at', 'is', null)
        .executeTakeFirst()) ?? null
    );
  });
  app.post(
    '/v1/driver/shift/start',
    {
      preHandler: app.auth(),
      schema: { body: Type.Intersect([Readings, Type.Object({ vehicleId: Id })]) },
    },
    async (req, reply) => {
      if (!req.user.driverId) throw forbidden('Not a driver account');
      const open = await db
        .selectFrom('driver_shifts')
        .select('id')
        .where('driver_id', '=', req.user.driverId)
        .where('ended_at', 'is', null)
        .executeTakeFirst();
      if (open) throw badRequest('Shift already started');
      // A driver already planned on a trip starts the shift on that trip's truck, not another one.
      const assigned = await db
        .selectFrom('legs as l')
        .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
        .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
        .select(['a.vehicle_id', 'v.reg_no'])
        .where('a.driver_id', '=', req.user.driverId)
        .where('l.status', 'in', ['active', 'planned'])
        .executeTakeFirst();
      if (assigned && assigned.vehicle_id !== req.body.vehicleId) {
        throw badRequest(
          `You are assigned to ${assigned.reg_no} on an open trip — start your shift on that truck`,
        );
      }
      const v = await db
        .selectFrom('vehicles')
        .select(['last_odometer_km'])
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.body.vehicleId)
        .executeTakeFirst();
      if (!v) throw badRequest('Unknown truck');
      const last = num(v.last_odometer_km);
      if (last !== null && req.body.odometer < last)
        throw badRequest(`Odometer cannot be lower than the last reading (${last} km)`);
      const { vehicleId, ...readings } = req.body;
      const row = await db
        .insertInto('driver_shifts')
        .values({
          tenant_id: req.user.tid,
          driver_id: req.user.driverId,
          vehicle_id: vehicleId,
          start_readings: json(readings),
          end_readings: json({}),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .updateTable('vehicles')
        .set({ last_odometer_km: req.body.odometer, last_soc_pct: req.body.soc })
        .where('id', '=', vehicleId)
        .execute();
      await recordEvent(db, {
        tenantId: req.user.tid,
        entity: 'vehicle',
        entityId: vehicleId,
        type: 'shift.started',
        actorId: req.user.sub,
        payload: readings,
      });
      return reply.code(201).send(row);
    },
  );
  app.post(
    '/v1/driver/shift/end',
    { preHandler: app.auth(), schema: { body: Readings } },
    async (req) => {
      if (!req.user.driverId) throw forbidden('Not a driver account');
      const open = await db
        .selectFrom('driver_shifts')
        .select(['id', 'vehicle_id', 'start_readings'])
        .where('driver_id', '=', req.user.driverId)
        .where('ended_at', 'is', null)
        .executeTakeFirst();
      if (!open) throw badRequest('No shift in progress');
      const start = (open.start_readings as { odometer?: number }).odometer ?? 0;
      if (req.body.odometer < start)
        throw badRequest(`Odometer cannot be lower than the start reading (${start} km)`);
      await db
        .updateTable('driver_shifts')
        .set({ ended_at: new Date(), end_readings: json(req.body) })
        .where('id', '=', open.id)
        .execute();
      if (open.vehicle_id) {
        await db
          .updateTable('vehicles')
          .set({ last_odometer_km: req.body.odometer, last_soc_pct: req.body.soc })
          .where('id', '=', open.vehicle_id)
          .execute();
        await recordEvent(db, {
          tenantId: req.user.tid,
          entity: 'vehicle',
          entityId: open.vehicle_id,
          type: 'shift.ended',
          actorId: req.user.sub,
          payload: { ...req.body, km: req.body.odometer - start },
        });
      }
      return { ok: true, km: req.body.odometer - start };
    },
  );

  // ── Fleet economics ──
  app.get(
    '/v1/dashboard/fleet',
    {
      preHandler: staff,
      schema: {
        querystring: Type.Object({
          days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
        }),
      },
    },
    async (req) => {
      const days = req.query.days ?? 7;
      const since = new Date(Date.now() - days * 86400000);
      const s = (await getSettings(db, req.user.tid)).dispatch;
      const legs = await db
        .selectFrom('legs as l')
        .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
        .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
        .innerJoin('locations as lf', 'lf.id', 'l.from_location_id')
        .innerJoin('locations as lt', 'lt.id', 'l.to_location_id')
        .select([
          'l.id',
          'l.trip_id',
          'l.kind',
          'l.ended_at',
          'v.reg_no',
          'lf.lat as fLat',
          'lf.lng as fLng',
          'lt.lat as tLat',
          'lt.lng as tLng',
        ])
        .where('l.tenant_id', '=', req.user.tid)
        .where('l.status', '=', 'completed')
        .where('l.ended_at', '>=', since)
        .execute();
      const km = (l: (typeof legs)[number]) =>
        l.fLat !== null && l.fLng !== null && l.tLat !== null && l.tLng !== null
          ? straightKm({ lat: l.fLat, lng: l.fLng }, { lat: l.tLat, lng: l.tLng }) * s.roadFactor
          : 0;
      const totalKm = legs.reduce((a, l) => a + km(l), 0);
      const emptyKm = legs.filter((l) => l.kind === 'empty').reduce((a, l) => a + km(l), 0);
      const trips = new Map<string, number>();
      for (const l of legs.filter((x) => x.kind === 'loaded'))
        trips.set(l.trip_id, (trips.get(l.trip_id) ?? 0) + 1);

      const revenue = await db
        .selectFrom('lrs as r')
        .innerJoin('legs as l', 'l.id', 'r.leg_id')
        .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
        .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
        .select([
          'v.reg_no',
          sql<string>`coalesce(sum(r.total_amount), 0)`.as('total'),
          sql<number>`count(*)::int`.as('lrs'),
        ])
        .where('r.tenant_id', '=', req.user.tid)
        .where('r.closed_at', '>=', since)
        .groupBy('v.reg_no')
        .execute();

      // Port turnaround: gate-in to gate-out, from the event log.
      const turnaround = await db
        .selectFrom('events as gi')
        .innerJoin('events as go', (j) => j.onRef('go.entity_id', '=', 'gi.entity_id'))
        .innerJoin('legs as l', 'l.id', 'gi.entity_id')
        .innerJoin('locations as lf', 'lf.id', 'l.from_location_id')
        .select([
          'lf.name',
          sql<number>`avg(extract(epoch from go.created_at - gi.created_at) / 60)::int`.as(
            'minutes',
          ),
          sql<number>`count(*)::int`.as('n'),
        ])
        .where('gi.tenant_id', '=', req.user.tid)
        .where('gi.type', '=', 'leg.step_completed')
        .where('go.type', '=', 'leg.step_completed')
        .where(
          sql<boolean>`gi.payload->>'step' = 'reach_pickup' and go.payload->>'step' = 'gate_out'`,
        )
        .where('gi.created_at', '>=', since)
        .groupBy('lf.name')
        .execute();

      const perTruck = new Map<string, { trips: Set<string>; km: number }>();
      for (const l of legs) {
        const t = perTruck.get(l.reg_no) ?? { trips: new Set(), km: 0 };
        t.trips.add(l.trip_id);
        t.km += km(l);
        perTruck.set(l.reg_no, t);
      }
      return {
        days,
        totalKm: Math.round(totalKm),
        emptyKm: Math.round(emptyKm),
        emptyKmPct: totalKm ? Math.round((emptyKm / totalKm) * 100) : null,
        completedTrips: new Set(legs.map((l) => l.trip_id)).size,
        roundTripPct: trips.size
          ? Math.round(([...trips.values()].filter((n) => n > 1).length / trips.size) * 100)
          : null,
        trucks: [...perTruck.entries()].map(([regNo, t]) => {
          const r = revenue.find((x) => x.reg_no === regNo);
          return {
            regNo,
            trips: t.trips.size,
            km: Math.round(t.km),
            revenue: Number(r?.total ?? 0),
            lrs: r?.lrs ?? 0,
          };
        }),
        turnaround,
        shadow: await shadowReport(db, req.user.tid),
      };
    },
  );
};

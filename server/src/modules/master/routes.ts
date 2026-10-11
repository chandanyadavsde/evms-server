import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { num } from '../../lib/db-utils';

/** Read-only master data for forms and the dispatch screen. Editing screens come later. */
export const masterRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const db = app.db;
  const staff = app.auth('admin', 'manager');

  app.get('/v1/master', { preHandler: staff }, async (req) => {
    const tid = req.user.tid;
    const [clients, locations, jobTypes, cargoTypes, vehicles, drivers] = await Promise.all([
      db
        .selectFrom('clients')
        .select(['id', 'code', 'name', 'aliases'])
        .where('tenant_id', '=', tid)
        .where('active', '=', true)
        .orderBy('name')
        .execute(),
      db
        .selectFrom('locations as l')
        .innerJoin('location_types as lt', 'lt.id', 'l.location_type_id')
        .select([
          'l.id',
          'l.code',
          'l.name',
          'l.lat',
          'l.lng',
          'l.charging',
          'l.aliases',
          'lt.code as type',
          'lt.name as typeName',
        ])
        .where('l.tenant_id', '=', tid)
        .orderBy('l.name')
        .execute(),
      db
        .selectFrom('job_types as j')
        .innerJoin('location_types as f', 'f.id', 'j.from_location_type_id')
        .innerJoin('location_types as t', 't.id', 'j.to_location_type_id')
        .select(['j.id', 'j.code', 'j.name', 'j.active', 'f.code as fromType', 't.code as toType'])
        .where('j.tenant_id', '=', tid)
        .execute(),
      db
        .selectFrom('cargo_types')
        .select(['id', 'code', 'name', 'uses', 'attributes'])
        .where('tenant_id', '=', tid)
        .execute(),
      db
        .selectFrom('vehicles as v')
        .innerJoin('vehicle_categories as vc', 'vc.id', 'v.category_id')
        .select([
          'v.id',
          'v.reg_no',
          'v.status',
          'v.last_soc_pct',
          'v.last_odometer_km',
          'v.battery_kwh',
          'vc.name as category',
          'vc.capacity',
        ])
        .where('v.tenant_id', '=', tid)
        .orderBy('v.reg_no')
        .execute(),
      db
        .selectFrom('drivers')
        .select(['id', 'name', 'phone', 'status'])
        .where('tenant_id', '=', tid)
        .orderBy('name')
        .execute(),
    ]);
    return {
      clients,
      locations,
      jobTypes,
      cargoTypes,
      vehicles: vehicles.map((v) => ({
        id: v.id,
        regNo: v.reg_no,
        status: v.status,
        category: v.category,
        capacity: v.capacity,
        soc: num(v.last_soc_pct),
        odometer: num(v.last_odometer_km),
        batteryKwh: num(v.battery_kwh),
      })),
      drivers,
    };
  });
};

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { Db } from '../../db/client';
import { json, recordEvent } from '../../lib/db-utils';
import { AppError, badRequest, notFound } from '../../lib/errors';

/**
 * Master data management: clients, places, vehicles, drivers and their documents.
 * Admin only. Everything here is data the engine reads — no code change for a new client or place.
 */

const Id = Type.String({ format: 'uuid' });
const Code = Type.String({ pattern: '^[A-Z0-9_-]{2,20}$' });

async function defaultRegion(db: Db, tenantId: string, regionId?: string) {
  const q = db.selectFrom('regions').select('id').where('tenant_id', '=', tenantId);
  const r = await (regionId
    ? q.where('id', '=', regionId)
    : q.orderBy('created_at')
  ).executeTakeFirst();
  if (!r) throw notFound('Region');
  return r.id;
}

/** Unique-violation → readable 409 instead of a 500. */
async function unique<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string }).code === '23505')
      throw new AppError(409, `${what} already exists`);
    throw err;
  }
}

export const adminRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const db = app.db;
  const admin = app.auth('admin');

  const Aliases = Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 30 });
  const cleanAliases = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

  // ── Clients ──────────────────────────────────────────────
  const ClientBody = Type.Object({
    code: Code,
    name: Type.String({ minLength: 2 }),
    gstin: Type.Optional(Type.String()),
    lrPrefix: Type.Optional(Type.String({ maxLength: 10 })),
    active: Type.Optional(Type.Boolean()),
    /** Other names smart intake should match: short names, portal group codes. */
    aliases: Type.Optional(Aliases),
  });
  app.get('/v1/admin/clients', { preHandler: admin }, async (req) =>
    db
      .selectFrom('clients')
      .selectAll()
      .where('tenant_id', '=', req.user.tid)
      .orderBy('name')
      .execute(),
  );
  app.post(
    '/v1/admin/clients',
    { preHandler: admin, schema: { body: ClientBody } },
    async (req, reply) => {
      const b = req.body;
      const row = await unique('Client code', () =>
        db
          .insertInto('clients')
          .values({
            tenant_id: req.user.tid,
            code: b.code,
            name: b.name,
            gstin: b.gstin ?? null,
            billing: json({ lrPrefix: b.lrPrefix ?? `${b.code}/` }),
            custom: json({}),
            aliases: json(cleanAliases(b.aliases ?? [])),
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      await recordEvent(db, {
        tenantId: req.user.tid,
        entity: 'client',
        entityId: row.id,
        type: 'client.created',
        actorId: req.user.sub,
      });
      return reply.code(201).send(row);
    },
  );
  app.patch(
    '/v1/admin/clients/:id',
    {
      preHandler: admin,
      schema: { params: Type.Object({ id: Id }), body: Type.Partial(ClientBody) },
    },
    async (req) => {
      const b = req.body;
      const current = await db
        .selectFrom('clients')
        .select('billing')
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!current) throw notFound('Client');
      await db
        .updateTable('clients')
        .set({
          ...(b.name ? { name: b.name } : {}),
          ...(b.gstin !== undefined ? { gstin: b.gstin } : {}),
          ...(b.active !== undefined ? { active: b.active } : {}),
          ...(b.aliases ? { aliases: json(cleanAliases(b.aliases)) } : {}),
          ...(b.lrPrefix ? { billing: json({ ...current.billing, lrPrefix: b.lrPrefix }) } : {}),
        })
        .where('id', '=', req.params.id)
        .execute();
      return { ok: true };
    },
  );

  // ── Places ───────────────────────────────────────────────
  const PlaceBody = Type.Object({
    code: Code,
    name: Type.String({ minLength: 2 }),
    typeCode: Type.String(),
    lat: Type.Number({ minimum: -90, maximum: 90 }),
    lng: Type.Number({ minimum: -180, maximum: 180 }),
    geofenceRadiusM: Type.Optional(Type.Integer({ minimum: 50, maximum: 5000 })),
    address: Type.Optional(Type.String()),
    charging: Type.Optional(
      Type.Object({
        available: Type.Boolean(),
        chargers: Type.Optional(Type.Integer()),
        powerKw: Type.Optional(Type.Number()),
      }),
    ),
    regionId: Type.Optional(Id),
    aliases: Type.Optional(Aliases),
  });
  app.get('/v1/admin/location-types', { preHandler: admin }, async (req) =>
    db
      .selectFrom('location_types')
      .selectAll()
      .where('tenant_id', '=', req.user.tid)
      .orderBy('name')
      .execute(),
  );
  app.post(
    '/v1/admin/locations',
    { preHandler: admin, schema: { body: PlaceBody } },
    async (req, reply) => {
      const b = req.body;
      const type = await db
        .selectFrom('location_types')
        .select('id')
        .where('tenant_id', '=', req.user.tid)
        .where('code', '=', b.typeCode)
        .executeTakeFirst();
      if (!type) throw badRequest(`Unknown place type ${b.typeCode}`);
      const row = await unique('Place code', async () =>
        db
          .insertInto('locations')
          .values({
            tenant_id: req.user.tid,
            region_id: await defaultRegion(db, req.user.tid, b.regionId),
            location_type_id: type.id,
            code: b.code,
            name: b.name,
            address: b.address ?? null,
            lat: b.lat,
            lng: b.lng,
            geofence_radius_m: b.geofenceRadiusM ?? 300,
            charging: json(b.charging ?? { available: false }),
            custom: json({}),
            aliases: json(cleanAliases(b.aliases ?? [])),
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      return reply.code(201).send(row);
    },
  );
  app.patch(
    '/v1/admin/locations/:id',
    {
      preHandler: admin,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Partial(Type.Omit(PlaceBody, ['typeCode', 'regionId'])),
      },
    },
    async (req) => {
      const b = req.body;
      const r = await db
        .updateTable('locations')
        .set({
          ...(b.name ? { name: b.name } : {}),
          ...(b.lat !== undefined ? { lat: b.lat } : {}),
          ...(b.lng !== undefined ? { lng: b.lng } : {}),
          ...(b.geofenceRadiusM ? { geofence_radius_m: b.geofenceRadiusM } : {}),
          ...(b.address !== undefined ? { address: b.address } : {}),
          ...(b.charging ? { charging: json(b.charging) } : {}),
          ...(b.aliases ? { aliases: json(cleanAliases(b.aliases)) } : {}),
        })
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!r.numUpdatedRows) throw notFound('Place');
      return { ok: true };
    },
  );

  // ── Vehicles ─────────────────────────────────────────────
  const VehicleBody = Type.Object({
    regNo: Type.String({ minLength: 4 }),
    categoryId: Id,
    batteryKwh: Type.Optional(Type.Number()),
    odometer: Type.Optional(Type.Number({ minimum: 0 })),
    soc: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    status: Type.Optional(
      Type.Union([Type.Literal('active'), Type.Literal('maintenance'), Type.Literal('inactive')]),
    ),
    regionId: Type.Optional(Id),
  });
  app.get('/v1/admin/vehicle-categories', { preHandler: admin }, async (req) =>
    db
      .selectFrom('vehicle_categories')
      .selectAll()
      .where('tenant_id', '=', req.user.tid)
      .orderBy('name')
      .execute(),
  );
  app.post(
    '/v1/admin/vehicles',
    { preHandler: admin, schema: { body: VehicleBody } },
    async (req, reply) => {
      const b = req.body;
      const row = await unique('Vehicle registration', async () =>
        db
          .insertInto('vehicles')
          .values({
            tenant_id: req.user.tid,
            region_id: await defaultRegion(db, req.user.tid, b.regionId),
            category_id: b.categoryId,
            reg_no: b.regNo.toUpperCase(),
            battery_kwh: b.batteryKwh ?? null,
            last_odometer_km: b.odometer ?? null,
            last_soc_pct: b.soc ?? null,
            custom: json({}),
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      return reply.code(201).send(row);
    },
  );
  app.patch(
    '/v1/admin/vehicles/:id',
    {
      preHandler: admin,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Partial(Type.Omit(VehicleBody, ['regionId'])),
      },
    },
    async (req) => {
      const b = req.body;
      const r = await db
        .updateTable('vehicles')
        .set({
          ...(b.regNo ? { reg_no: b.regNo.toUpperCase() } : {}),
          ...(b.categoryId ? { category_id: b.categoryId } : {}),
          ...(b.batteryKwh !== undefined ? { battery_kwh: b.batteryKwh } : {}),
          ...(b.status ? { status: b.status } : {}),
        })
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!r.numUpdatedRows) throw notFound('Vehicle');
      return { ok: true };
    },
  );

  // ── Drivers (each gets a login) ──────────────────────────
  const DriverBody = Type.Object({
    name: Type.String({ minLength: 2 }),
    phone: Type.String({ pattern: '^\\d{10}$' }),
    language: Type.Optional(Type.String({ minLength: 2, maxLength: 5 })),
    licenceNo: Type.Optional(Type.String()),
    status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
    regionId: Type.Optional(Id),
  });
  app.post(
    '/v1/admin/drivers',
    { preHandler: admin, schema: { body: DriverBody } },
    async (req, reply) => {
      const b = req.body;
      const t = req.user.tid;
      const regionId = await defaultRegion(db, t, b.regionId);
      const id = await unique('Driver phone', () =>
        db.transaction().execute(async (tx) => {
          const user = await tx
            .insertInto('users')
            .values({ tenant_id: t, name: b.name, phone: b.phone, language: b.language ?? 'hi' })
            .returning('id')
            .executeTakeFirstOrThrow();
          const role = await tx
            .selectFrom('roles')
            .select('id')
            .where('tenant_id', '=', t)
            .where('code', '=', 'driver')
            .executeTakeFirstOrThrow();
          await tx
            .insertInto('user_roles')
            .values({ user_id: user.id, role_id: role.id, region_id: null })
            .execute();
          const d = await tx
            .insertInto('drivers')
            .values({
              tenant_id: t,
              region_id: regionId,
              user_id: user.id,
              name: b.name,
              phone: b.phone,
              licence_no: b.licenceNo ?? null,
              custom: json({}),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          return d.id;
        }),
      );
      return reply.code(201).send({ id });
    },
  );
  app.patch(
    '/v1/admin/drivers/:id',
    {
      preHandler: admin,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Partial(Type.Omit(DriverBody, ['phone', 'regionId'])),
      },
    },
    async (req) => {
      const b = req.body;
      const d = await db
        .selectFrom('drivers')
        .select(['id', 'user_id'])
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!d) throw notFound('Driver');
      await db
        .updateTable('drivers')
        .set({
          ...(b.name ? { name: b.name } : {}),
          ...(b.licenceNo !== undefined ? { licence_no: b.licenceNo } : {}),
          ...(b.status ? { status: b.status } : {}),
        })
        .where('id', '=', d.id)
        .execute();
      if (d.user_id && (b.language || b.status || b.name)) {
        await db
          .updateTable('users')
          .set({
            ...(b.language ? { language: b.language } : {}),
            ...(b.name ? { name: b.name } : {}),
            ...(b.status ? { active: b.status === 'active' } : {}),
          })
          .where('id', '=', d.user_id)
          .execute();
      }
      return { ok: true };
    },
  );

  // ── Documents with expiry (licence, port pass, permit, insurance…) ──
  app.get(
    '/v1/admin/documents',
    {
      preHandler: app.auth('admin', 'manager'),
      schema: {
        querystring: Type.Object({
          entity: Type.Optional(Type.String()),
          entityId: Type.Optional(Id),
        }),
      },
    },
    async (req) => {
      let q = db.selectFrom('entity_documents').selectAll().where('tenant_id', '=', req.user.tid);
      if (req.query.entity) q = q.where('entity', '=', req.query.entity as 'driver' | 'vehicle');
      if (req.query.entityId) q = q.where('entity_id', '=', req.query.entityId);
      return q.orderBy('expires_at').execute();
    },
  );
  app.post(
    '/v1/admin/documents',
    {
      preHandler: admin,
      schema: {
        body: Type.Object({
          entity: Type.Union([Type.Literal('driver'), Type.Literal('vehicle')]),
          entityId: Id,
          docType: Type.String({ minLength: 2 }),
          number: Type.Optional(Type.String()),
          expiresAt: Type.Optional(Type.String({ format: 'date' })),
          fileKey: Type.Optional(Type.String()),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body;
      const row = await db
        .insertInto('entity_documents')
        .values({
          tenant_id: req.user.tid,
          entity: b.entity,
          entity_id: b.entityId,
          doc_type: b.docType,
          number: b.number?.trim() || null,
          expires_at: b.expiresAt ?? null,
          file_key: b.fileKey ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return reply.code(201).send(row);
    },
  );
  app.delete(
    '/v1/admin/documents/:id',
    { preHandler: admin, schema: { params: Type.Object({ id: Id }) } },
    async (req) => {
      await db
        .deleteFrom('entity_documents')
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .execute();
      return { ok: true };
    },
  );

  // ── Tenant settings (exception thresholds, autonomy levels, dispatch weights) ──
  app.get('/v1/admin/settings', { preHandler: app.auth('admin', 'manager') }, async (req) => {
    const t = await db
      .selectFrom('tenants')
      .select('settings')
      .where('id', '=', req.user.tid)
      .executeTakeFirstOrThrow();
    return t.settings;
  });
  app.put(
    '/v1/admin/settings',
    { preHandler: admin, schema: { body: Type.Record(Type.String(), Type.Unknown()) } },
    async (req) => {
      await db
        .updateTable('tenants')
        .set({ settings: json(req.body) })
        .where('id', '=', req.user.tid)
        .execute();
      await recordEvent(db, {
        tenantId: req.user.tid,
        entity: 'tenant',
        entityId: req.user.tid,
        type: 'settings.updated',
        actorId: req.user.sub,
      });
      return { ok: true };
    },
  );
};

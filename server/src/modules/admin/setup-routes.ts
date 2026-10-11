import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { json, recordEvent } from '../../lib/db-utils';
import { AppError, badRequest, notFound } from '../../lib/errors';

/**
 * Phase 1 masters the supervisor web needs on top of clients/places: each port's portal address and
 * group codes, which trip types are in use, and supervisors with their assigned ports and CFSs.
 */

const Id = Type.String({ format: 'uuid' });

/** "https://Portal.NSFT.com/eform13/" → "portal.nsft.com/eform13" — matched as a prefix of page URLs. */
export const normalizePortalUrl = (u: string) =>
  u
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');

async function unique<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new AppError(409, `${what} already exists`);
    }
    throw err;
  }
}

export const setupRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const db = app.db;
  const admin = app.auth('admin');

  async function portOf(tenantId: string, id: string) {
    const port = await db
      .selectFrom('locations as l')
      .innerJoin('location_types as lt', 'lt.id', 'l.location_type_id')
      .select(['l.id', 'lt.code as type'])
      .where('l.tenant_id', '=', tenantId)
      .where('l.id', '=', id)
      .executeTakeFirst();
    if (!port) throw notFound('Port');
    if (port.type !== 'PORT_TERMINAL') throw badRequest('This place is not a port');
    return port;
  }

  // ── Ports: portal address + group codes ──────────────────
  app.get('/v1/admin/ports', { preHandler: app.auth('admin', 'manager') }, async (req) => {
    const ports = await db
      .selectFrom('locations as l')
      .innerJoin('location_types as lt', 'lt.id', 'l.location_type_id')
      .select(['l.id', 'l.code', 'l.name', 'l.aliases', 'l.portal'])
      .where('l.tenant_id', '=', req.user.tid)
      .where('lt.code', '=', 'PORT_TERMINAL')
      .orderBy('l.name')
      .execute();
    const codes = await db
      .selectFrom('port_group_codes as g')
      .innerJoin('clients as c', 'c.id', 'g.client_id')
      .select(['g.id', 'g.port_id', 'g.code', 'g.client_id as clientId', 'c.name as clientName'])
      .where('g.tenant_id', '=', req.user.tid)
      .orderBy('g.code')
      .execute();
    return ports.map((p) => ({
      ...p,
      portal: { urls: p.portal.urls ?? [] },
      groupCodes: codes.filter((c) => c.port_id === p.id).map(({ port_id: _p, ...c }) => c),
    }));
  });

  app.put(
    '/v1/admin/ports/:id/portal',
    {
      preHandler: admin,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Object({
          urls: Type.Array(Type.String({ minLength: 4, maxLength: 300 }), { maxItems: 10 }),
        }),
      },
    },
    async (req) => {
      await portOf(req.user.tid, req.params.id);
      const urls = [...new Set(req.body.urls.map(normalizePortalUrl).filter(Boolean))];
      await db
        .updateTable('locations')
        .set({ portal: json({ urls }) })
        .where('id', '=', req.params.id)
        .execute();
      return { ok: true, urls };
    },
  );

  app.post(
    '/v1/admin/ports/:id/group-codes',
    {
      preHandler: admin,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Object({
          code: Type.String({ minLength: 1, maxLength: 20 }),
          clientId: Id,
        }),
      },
    },
    async (req, reply) => {
      await portOf(req.user.tid, req.params.id);
      const client = await db
        .selectFrom('clients')
        .select('id')
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.body.clientId)
        .executeTakeFirst();
      if (!client) throw notFound('Client');
      const row = await unique('This group code for this port', () =>
        db
          .insertInto('port_group_codes')
          .values({
            tenant_id: req.user.tid,
            port_id: req.params.id,
            code: req.body.code.trim().toUpperCase(),
            client_id: req.body.clientId,
          })
          .returning('id')
          .executeTakeFirstOrThrow(),
      );
      return reply.code(201).send(row);
    },
  );

  app.delete(
    '/v1/admin/ports/:id/group-codes/:codeId',
    { preHandler: admin, schema: { params: Type.Object({ id: Id, codeId: Id }) } },
    async (req) => {
      await db
        .deleteFrom('port_group_codes')
        .where('tenant_id', '=', req.user.tid)
        .where('port_id', '=', req.params.id)
        .where('id', '=', req.params.codeId)
        .execute();
      return { ok: true };
    },
  );

  // ── Trip types ───────────────────────────────────────────
  app.get('/v1/admin/trip-types', { preHandler: app.auth('admin', 'manager') }, async (req) =>
    db
      .selectFrom('job_types as j')
      .innerJoin('location_types as f', 'f.id', 'j.from_location_type_id')
      .innerJoin('location_types as t', 't.id', 'j.to_location_type_id')
      .select(['j.id', 'j.code', 'j.name', 'j.active', 'f.name as fromType', 't.name as toType'])
      .where('j.tenant_id', '=', req.user.tid)
      .orderBy('j.name')
      .execute(),
  );
  app.patch(
    '/v1/admin/trip-types/:id',
    {
      preHandler: admin,
      schema: { params: Type.Object({ id: Id }), body: Type.Object({ active: Type.Boolean() }) },
    },
    async (req) => {
      const r = await db
        .updateTable('job_types')
        .set({ active: req.body.active })
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!r.numUpdatedRows) throw notFound('Trip type');
      return { ok: true };
    },
  );

  // ── Supervisors (and admins) with their ports and CFSs ───
  app.get('/v1/admin/users', { preHandler: admin }, async (req) => {
    const users = await db
      .selectFrom('users as u')
      .innerJoin('user_roles as ur', 'ur.user_id', 'u.id')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .select(['u.id', 'u.name', 'u.email', 'u.phone', 'u.active', 'r.code as role'])
      .where('u.tenant_id', '=', req.user.tid)
      .where('r.code', 'in', ['admin', 'manager'])
      .orderBy('u.name')
      .execute();
    const scopes = await db
      .selectFrom('user_scopes as s')
      .innerJoin('locations as l', 'l.id', 's.location_id')
      .innerJoin('location_types as lt', 'lt.id', 'l.location_type_id')
      .select(['s.user_id', 'l.id', 'l.name', 'lt.code as type'])
      .where('s.tenant_id', '=', req.user.tid)
      .execute();
    return users.map((u) => ({
      ...u,
      places: scopes.filter((s) => s.user_id === u.id).map(({ user_id: _u, ...s }) => s),
    }));
  });

  app.post(
    '/v1/admin/users',
    {
      preHandler: admin,
      schema: {
        body: Type.Object({
          name: Type.String({ minLength: 2, maxLength: 100 }),
          email: Type.String({ format: 'email', maxLength: 200 }),
          phone: Type.Optional(Type.String({ pattern: '^[0-9]{10}$' })),
          role: Type.Union([Type.Literal('manager'), Type.Literal('admin')]),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body;
      const role = await db
        .selectFrom('roles')
        .select('id')
        .where('tenant_id', '=', req.user.tid)
        .where('code', '=', b.role)
        .executeTakeFirstOrThrow();
      const user = await unique('A user with this email or phone', () =>
        db.transaction().execute(async (tx) => {
          const u = await tx
            .insertInto('users')
            .values({
              tenant_id: req.user.tid,
              name: b.name.trim(),
              email: b.email.trim().toLowerCase(),
              phone: b.phone ?? null,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await tx.insertInto('user_roles').values({ user_id: u.id, role_id: role.id }).execute();
          return u;
        }),
      );
      await recordEvent(db, {
        tenantId: req.user.tid,
        entity: 'user',
        entityId: user.id,
        type: 'user.created',
        actorId: req.user.sub,
        payload: { role: b.role },
      });
      return reply.code(201).send(user);
    },
  );

  app.patch(
    '/v1/admin/users/:id',
    {
      preHandler: admin,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 2, maxLength: 100 })),
          active: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => {
      if (req.body.active === false && req.params.id === req.user.sub) {
        throw badRequest('You cannot switch off your own account');
      }
      const r = await db
        .updateTable('users')
        .set({
          ...(req.body.name ? { name: req.body.name.trim() } : {}),
          ...(req.body.active !== undefined ? { active: req.body.active } : {}),
        })
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!r.numUpdatedRows) throw notFound('User');
      return { ok: true };
    },
  );

  /** Replaces the ports and CFSs a supervisor works on. Empty = all places. */
  app.put(
    '/v1/admin/users/:id/places',
    {
      preHandler: admin,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Object({ locationIds: Type.Array(Id, { maxItems: 100 }) }),
      },
    },
    async (req) => {
      const user = await db
        .selectFrom('users')
        .select('id')
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!user) throw notFound('User');
      const ids = [...new Set(req.body.locationIds)];
      if (ids.length) {
        const ok = await db
          .selectFrom('locations as l')
          .innerJoin('location_types as lt', 'lt.id', 'l.location_type_id')
          .select('l.id')
          .where('l.tenant_id', '=', req.user.tid)
          .where('l.id', 'in', ids)
          .where('lt.code', 'in', ['PORT_TERMINAL', 'CFS'])
          .execute();
        if (ok.length !== ids.length) throw badRequest('Only ports and CFSs can be assigned');
      }
      await db.transaction().execute(async (tx) => {
        await tx
          .deleteFrom('user_scopes')
          .where('tenant_id', '=', req.user.tid)
          .where('user_id', '=', req.params.id)
          .execute();
        if (ids.length) {
          await tx
            .insertInto('user_scopes')
            .values(
              ids.map((location_id) => ({
                tenant_id: req.user.tid,
                user_id: req.params.id,
                location_id,
              })),
            )
            .execute();
        }
      });
      await recordEvent(db, {
        tenantId: req.user.tid,
        entity: 'user',
        entityId: req.params.id,
        type: 'user.places_assigned',
        actorId: req.user.sub,
        payload: { locationIds: ids },
      });
      return { ok: true, count: ids.length };
    },
  );
};

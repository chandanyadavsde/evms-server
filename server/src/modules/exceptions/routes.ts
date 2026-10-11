import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { recordEvent } from '../../lib/db-utils';
import { notFound } from '../../lib/errors';
import { runExceptionChecks } from './engine';

export const exceptionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const db = app.db;
  const staff = app.auth('admin', 'manager');

  app.get(
    '/v1/exceptions',
    {
      preHandler: staff,
      schema: { querystring: Type.Object({ status: Type.Optional(Type.String()) }) },
    },
    async (req) =>
      db
        .selectFrom('exceptions')
        .selectAll()
        .where('tenant_id', '=', req.user.tid)
        .where('status', '=', (req.query.status ?? 'open') as 'open')
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute(),
  );

  /** Run the checks now (they also run every minute in the background). */
  app.post('/v1/exceptions/run', { preHandler: staff }, async (req) =>
    runExceptionChecks(db, req.user.tid),
  );

  for (const outcome of ['resolve', 'dismiss'] as const) {
    app.post(
      `/v1/exceptions/:id/${outcome}`,
      {
        preHandler: staff,
        schema: {
          params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
          body: Type.Object({ note: Type.Optional(Type.String()) }),
        },
      },
      async (req) => {
        const r = await db
          .updateTable('exceptions')
          .set({
            status: outcome === 'resolve' ? 'resolved' : 'dismissed',
            resolved_at: new Date(),
            resolved_by: req.user.sub,
            resolution: req.body.note ?? (outcome === 'resolve' ? 'Handled' : 'Dismissed'),
          })
          .where('tenant_id', '=', req.user.tid)
          .where('id', '=', req.params.id)
          .where('status', '=', 'open')
          .returning(['entity', 'entity_id', 'type'])
          .executeTakeFirst();
        if (!r) throw notFound('Open exception');
        // Overrides are learning data: why the manager acted (or didn't).
        await recordEvent(db, {
          tenantId: req.user.tid,
          entity: r.entity,
          entityId: r.entity_id,
          type: `exception.${outcome}d`,
          actorId: req.user.sub,
          payload: { type: r.type, note: req.body.note ?? null },
        });
        return { ok: true };
      },
    );
  }
};

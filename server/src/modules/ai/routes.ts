import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { recordEvent } from '../../lib/db-utils';
import type { Extractor } from './extractor';
import {
  confirmExtraction,
  getExtraction,
  listTemplates,
  publishTemplate,
  runExtraction,
} from './service';

export const aiRoutes: FastifyPluginAsyncTypebox<{
  extractor: Extractor | null;
  filesDir: string;
}> = async (app, opts) => {
  const db = app.db;
  const staff = app.auth('admin', 'manager');
  const deps = { db, extractor: opts.extractor, filesDir: opts.filesDir };

  app.get('/v1/ai/status', { preHandler: staff }, async () => ({
    enabled: !!opts.extractor,
    model: opts.extractor?.model ?? null,
  }));
  app.get('/v1/ai/templates', { preHandler: staff }, async (req) =>
    listTemplates(db, req.user.tid),
  );
  app.post(
    '/v1/ai/templates',
    { preHandler: app.auth('admin'), schema: { body: Type.Object({ template: Type.Unknown() }) } },
    async (req, reply) => {
      const id = await publishTemplate(db, req.user.tid, req.body.template);
      await recordEvent(db, {
        tenantId: req.user.tid,
        entity: 'config',
        entityId: id,
        type: 'extraction_template.published',
        actorId: req.user.sub,
      });
      return reply.code(201).send({ id });
    },
  );

  /** Upload first (/v1/files), then ask AI to read it. Takes a few seconds. */
  app.post(
    '/v1/ai/extractions',
    {
      preHandler: staff,
      schema: { body: Type.Object({ fileKey: Type.String(), templateKey: Type.String() }) },
    },
    async (req, reply) => reply.code(201).send(await runExtraction(deps, req.user, req.body)),
  );
  app.get(
    '/v1/ai/extractions',
    {
      preHandler: staff,
      schema: { querystring: Type.Object({ status: Type.Optional(Type.String()) }) },
    },
    async (req) => {
      let q = db.selectFrom('ai_extractions').selectAll().where('tenant_id', '=', req.user.tid);
      if (req.query.status) q = q.where('status', '=', req.query.status as 'done');
      return q.orderBy('created_at', 'desc').limit(100).execute();
    },
  );
  app.get(
    '/v1/ai/extractions/:id',
    { preHandler: staff, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } },
    async (req) => getExtraction(db, req.user.tid, req.params.id),
  );
  app.post(
    '/v1/ai/extractions/:id/confirm',
    {
      preHandler: staff,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object({
          records: Type.Array(
            Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()])),
          ),
        }),
      },
    },
    async (req) => confirmExtraction(db, req.user, req.params.id, req.body.records),
  );
  app.post(
    '/v1/ai/extractions/:id/reject',
    { preHandler: staff, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } },
    async (req) => {
      await db
        .updateTable('ai_extractions')
        .set({ status: 'rejected', confirmed_by: req.user.sub, confirmed_at: new Date() })
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .execute();
      return { ok: true };
    },
  );
};

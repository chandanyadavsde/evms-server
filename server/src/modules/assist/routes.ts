import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { VisionModel } from '../ai/llm';
import { forgetPage, listLearnedPages, mapForm, pasteSources, rememberFill } from './service';

/**
 * Smart paste for the plugin: fill a portal form (PIN / gate pass) from a VMS job. The plugin
 * fills the fields; the manager presses the portal's own submit button.
 */
export const assistRoutes: FastifyPluginAsyncTypebox<{ model: VisionModel | null }> = async (
  app,
  opts,
) => {
  const db = app.db;
  const staff = app.auth('admin', 'manager');
  const deps = { db, model: opts.model };

  app.get('/v1/assist/sources', { preHandler: staff }, async (req) =>
    pasteSources(db, req.user.tid),
  );

  const Field = Type.Object({
    key: Type.String({ maxLength: 200 }),
    label: Type.String({ maxLength: 200 }),
    kind: Type.Union(
      ['text', 'number', 'select', 'date', 'textarea', 'radio', 'checkbox'].map((k) =>
        Type.Literal(k),
      ),
    ),
    options: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 200 })),
    maxLength: Type.Optional(Type.Integer()),
  });

  app.post(
    '/v1/assist/map',
    {
      preHandler: staff,
      schema: {
        body: Type.Object({
          url: Type.String({ maxLength: 2000 }),
          fields: Type.Array(Field, { minItems: 1, maxItems: 60 }),
          data: Type.Record(Type.String(), Type.String({ maxLength: 500 })),
        }),
      },
    },
    async (req) => mapForm(deps, req.user, req.body as Parameters<typeof mapForm>[2]),
  );

  app.post(
    '/v1/assist/filled',
    {
      preHandler: staff,
      schema: {
        body: Type.Object({
          url: Type.String({ maxLength: 2000 }),
          title: Type.String({ maxLength: 300 }),
          legId: Type.Optional(Type.String({ format: 'uuid' })),
          fields: Type.Array(
            Type.Object({
              key: Type.String({ maxLength: 200 }),
              label: Type.String({ maxLength: 200 }),
              dataKey: Type.String({ maxLength: 40 }),
            }),
            { maxItems: 60 },
          ),
        }),
      },
    },
    async (req) => rememberFill(db, req.user, req.body),
  );

  app.get('/v1/assist/pages', { preHandler: staff }, async (req) =>
    listLearnedPages(db, req.user.tid),
  );
  app.delete(
    '/v1/assist/pages/:id',
    { preHandler: staff, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } },
    async (req) => forgetPage(db, req.user.tid, req.params.id),
  );
};

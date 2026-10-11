import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { ConfirmedMove } from '@vms/contracts';
import type { IntakeReader } from './reader';
import { confirmIntake, discardIntake, getIntake, listIntakes, readIntake } from './service';

/**
 * Smart intake: paste a message or screenshots → the reasoning layer drafts moves → the manager
 * fixes what is unsure or missing and confirms. Files are uploaded first via /v1/files.
 */
export const intakeRoutes: FastifyPluginAsyncTypebox<{
  reader: IntakeReader;
  filesDir: string;
  /** Free Gemini key: inputs may be used by Google — the UI warns to use test data only. */
  testDataOnly: boolean;
}> = async (app, opts) => {
  const db = app.db;
  const staff = app.auth('admin', 'manager');
  const deps = { db, reader: opts.reader, filesDir: opts.filesDir };
  const Id = Type.Object({ id: Type.String({ format: 'uuid' }) });

  app.get('/v1/intake/status', { preHandler: staff }, async () => ({
    reader: opts.reader.name,
    readsImages: opts.reader.readsImages,
    testDataOnly: opts.testDataOnly,
    spentUsd: opts.reader.spentUsd ?? null,
  }));

  app.post(
    '/v1/intake/read',
    {
      preHandler: staff,
      schema: {
        body: Type.Object({
          text: Type.Optional(Type.String({ maxLength: 20000 })),
          fileKeys: Type.Array(Type.String(), { maxItems: 6, default: [] }),
          /** Set by the plugin: the page the area was copied from. */
          source: Type.Optional(
            Type.Object({
              kind: Type.Literal('plugin'),
              url: Type.String({ maxLength: 2000 }),
              title: Type.String({ maxLength: 300 }),
            }),
          ),
        }),
      },
    },
    async (req, reply) => reply.code(201).send(await readIntake(deps, req.user, req.body)),
  );

  app.get('/v1/intake', { preHandler: staff }, async (req) => listIntakes(db, req.user.tid));
  app.get('/v1/intake/:id', { preHandler: staff, schema: { params: Id } }, async (req) =>
    getIntake(db, req.user.tid, req.params.id),
  );
  app.post(
    '/v1/intake/:id/confirm',
    {
      preHandler: staff,
      schema: {
        params: Id,
        body: Type.Object({ moves: Type.Array(ConfirmedMove, { maxItems: 50 }) }),
      },
    },
    async (req) => confirmIntake(db, req.user, req.params.id, req.body.moves),
  );
  app.post('/v1/intake/:id/discard', { preHandler: staff, schema: { params: Id } }, async (req) =>
    discardIntake(db, req.user, req.params.id),
  );
};

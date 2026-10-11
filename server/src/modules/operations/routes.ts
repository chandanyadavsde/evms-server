import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import { forbidden } from '../../lib/errors';
import {
  actOnLeg,
  appendLeg,
  cancelMove,
  createMove,
  createTrip,
  getLegScreen,
  listLrs,
  listMoves,
  managerTasks,
  setMoveContainer,
  tripBoard,
  tripEvents,
} from './service';

const Id = Type.String({ format: 'uuid' });
const LegInput = Type.Object({
  fromLocationId: Id,
  toLocationId: Id,
  moveIds: Type.Array(Id),
  driverId: Type.Optional(Id),
});

/** The user's saved language wins; the browser/app language is only a fallback. */
const langOf = (req: FastifyRequest) =>
  req.user.lang || req.headers['accept-language']?.split(',')[0]?.split('-')[0]?.trim() || 'en';

export const operationsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const db = app.db;
  const staff = app.auth('admin', 'manager');
  const anyone = app.auth();

  // Moves
  app.get(
    '/v1/moves',
    {
      preHandler: staff,
      schema: { querystring: Type.Object({ status: Type.Optional(Type.String()) }) },
    },
    async (req) => listMoves(db, req.user.tid, req.query.status),
  );
  app.post(
    '/v1/moves',
    {
      preHandler: staff,
      schema: {
        body: Type.Object({
          clientId: Id,
          jobTypeId: Id,
          /** Optional until the LR is issued (pendency gives counts, not numbers). */
          containerNumber: Type.Optional(Type.String({ maxLength: 13 })),
          cargoTypeId: Id,
          fromLocationId: Id,
          toLocationId: Id,
          readyAt: Type.Optional(Type.String()),
          cutoffAt: Type.Optional(Type.String()),
          custom: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
      },
    },
    async (req, reply) => reply.code(201).send(await createMove(db, req.user, req.body)),
  );

  app.post(
    '/v1/moves/:id/cancel',
    {
      preHandler: staff,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Object({ reason: Type.Optional(Type.String()) }),
      },
    },
    async (req) => cancelMove(db, req.user, req.params.id, req.body.reason),
  );

  app.post(
    '/v1/moves/:id/container',
    {
      preHandler: staff,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Object({ containerNumber: Type.String({ minLength: 11, maxLength: 13 }) }),
      },
    },
    async (req) => setMoveContainer(db, req.user, req.params.id, req.body.containerNumber),
  );

  // Trips & legs
  app.get(
    '/v1/trips',
    {
      preHandler: staff,
      schema: { querystring: Type.Object({ status: Type.Optional(Type.String()) }) },
    },
    async (req) =>
      tripBoard(db, req.user, { ...(req.query.status ? { status: req.query.status } : {}) }),
  );
  app.get(
    '/v1/trips/:id',
    { preHandler: staff, schema: { params: Type.Object({ id: Id }) } },
    async (req) => {
      const [trip] = await tripBoard(db, req.user, { tripId: req.params.id });
      return trip ?? null;
    },
  );
  app.get(
    '/v1/trips/:id/events',
    { preHandler: staff, schema: { params: Type.Object({ id: Id }) } },
    async (req) => tripEvents(db, req.user.tid, req.params.id),
  );
  app.post(
    '/v1/trips',
    {
      preHandler: staff,
      schema: {
        body: Type.Object({
          vehicleId: Id,
          driverId: Id,
          legs: Type.Array(LegInput, { minItems: 1 }),
        }),
      },
    },
    async (req, reply) => reply.code(201).send(await createTrip(db, req.user, req.body)),
  );
  app.post(
    '/v1/trips/:id/legs',
    { preHandler: staff, schema: { params: Type.Object({ id: Id }), body: LegInput } },
    async (req, reply) =>
      reply.code(201).send(await appendLeg(db, req.user, req.params.id, req.body)),
  );

  app.get(
    '/v1/legs/:id/screen',
    { preHandler: anyone, schema: { params: Type.Object({ id: Id }) } },
    async (req) => getLegScreen(db, req.user, req.params.id, langOf(req)),
  );
  app.post(
    '/v1/legs/:id/actions/:action',
    {
      preHandler: anyone,
      schema: {
        params: Type.Object({ id: Id, action: Type.String() }),
        body: Type.Object({ values: Type.Record(Type.String(), Type.Unknown()) }),
      },
    },
    async (req) =>
      actOnLeg(db, req.user, req.params.id, req.params.action, req.body.values, langOf(req)),
  );

  // Driver: my work
  app.get('/v1/driver/trips', { preHandler: anyone }, async (req) => {
    if (!req.user.driverId) throw forbidden('Not a driver account');
    return tripBoard(db, req.user, { status: 'active', driverId: req.user.driverId });
  });

  // Manager: work waiting on a person
  app.get('/v1/tasks', { preHandler: staff }, async (req) => managerTasks(db, req.user));

  // LRs
  app.get('/v1/lrs', { preHandler: staff }, async (req) => listLrs(db, req.user.tid));
};

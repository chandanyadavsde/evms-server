import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ChargeLine, RateCard } from '@vms/contracts';
import { priceLr } from '../../domain/charges';
import { num, recordEvent } from '../../lib/db-utils';
import { AppError, notFound } from '../../lib/errors';
import { type NetSuiteConfig, processOutbox } from './netsuite';
import { approveLr, lrDetail, publishRateCard } from './service';

const Id = Type.String({ format: 'uuid' });

export const billingRoutes: FastifyPluginAsyncTypebox<{ netsuite: NetSuiteConfig }> = async (
  app,
  opts,
) => {
  const db = app.db;
  const staff = app.auth('admin', 'manager');
  const admin = app.auth('admin');

  app.get(
    '/v1/lrs/:id',
    { preHandler: staff, schema: { params: Type.Object({ id: Id }) } },
    async (req) => lrDetail(db, req.user.tid, req.params.id),
  );

  app.post(
    '/v1/lrs/:id/approve',
    {
      preHandler: staff,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Object({ lines: Type.Optional(Type.Array(ChargeLine)) }),
      },
    },
    async (req) => {
      await approveLr(db, req.user, req.params.id, req.body.lines);
      return lrDetail(db, req.user.tid, req.params.id);
    },
  );

  // ── NetSuite outbox ──
  app.get('/v1/billing/outbox', { preHandler: staff }, async (req) => {
    const rows = await db
      .selectFrom('integration_outbox as o')
      .leftJoin('lrs as r', 'r.id', 'o.entity_id')
      .leftJoin('clients as c', 'c.id', 'r.client_id')
      .select([
        'o.id',
        'o.status',
        'o.attempts',
        'o.last_error',
        'o.external_ref',
        'o.created_at',
        'o.sent_at',
        'r.id as lrId',
        'r.number as lrNumber',
        'r.total_amount',
        'c.name as clientName',
      ])
      .where('o.tenant_id', '=', req.user.tid)
      .orderBy('o.created_at', 'desc')
      .limit(200)
      .execute();
    return {
      mode: opts.netsuite.mode,
      items: rows.map(({ total_amount, ...r }) => ({ ...r, total: num(total_amount) })),
    };
  });
  app.post('/v1/billing/outbox/process', { preHandler: staff }, async () =>
    processOutbox(db, opts.netsuite),
  );
  app.post(
    '/v1/billing/outbox/:id/retry',
    { preHandler: staff, schema: { params: Type.Object({ id: Id }) } },
    async (req) => {
      const item = await db
        .selectFrom('integration_outbox')
        .select('id')
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!item) throw notFound('Outbox item');
      return processOutbox(db, opts.netsuite, item.id);
    },
  );

  // ── Rate cards (configuration) ──
  app.get('/v1/config/rate-cards', { preHandler: staff }, async (req) => {
    const rows = await db
      .selectFrom('config_definitions as d')
      .leftJoin('clients as c', 'c.id', 'd.client_id')
      .select([
        'd.id',
        'd.key',
        'd.version',
        'd.status',
        'd.published_at as publishedAt',
        'd.body',
        'c.name as clientName',
      ])
      .where('d.tenant_id', '=', req.user.tid)
      .where('d.kind', '=', 'rate_card')
      .orderBy('d.key')
      .orderBy('d.version', 'desc')
      .execute();
    return rows.map(({ body, ...r }) => ({
      ...r,
      body,
      name: (body as RateCard).name,
      scope: r.clientName ?? 'Company',
    }));
  });
  app.post(
    '/v1/config/rate-cards',
    {
      preHandler: admin,
      schema: { body: Type.Object({ rateCard: Type.Unknown(), clientId: Type.Optional(Id) }) },
    },
    async (req, reply) => {
      const id = await publishRateCard(
        db,
        req.user.tid,
        req.body.rateCard,
        req.body.clientId ? { clientId: req.body.clientId } : {},
      );
      await recordEvent(db, {
        tenantId: req.user.tid,
        entity: 'config',
        entityId: id,
        type: 'rate_card.published',
        actorId: req.user.sub,
      });
      return reply.code(201).send({ id });
    },
  );
  /** Try a rate card on a sample before publishing it. */
  app.post(
    '/v1/config/rate-cards/quote',
    {
      preHandler: staff,
      schema: {
        body: Type.Object({
          rateCard: Type.Unknown(),
          sample: Type.Object({
            jobType: Type.String(),
            from: Type.String(),
            to: Type.String(),
            sizes: Type.Array(Type.String(), { minItems: 1 }),
            state: Type.Optional(Type.Union([Type.Literal('loaded'), Type.Literal('empty')])),
            portMinutes: Type.Optional(Type.Number({ minimum: 0 })),
          }),
        }),
      },
    },
    async (req) => {
      const errors = [...Value.Errors(RateCard, req.body.rateCard)].map(
        (e) => `${e.path || '/'}: ${e.message}`,
      );
      if (errors.length) throw new AppError(422, 'Rate card does not match schema', errors);
      const s = req.body.sample;
      const start = new Date('2026-01-01T09:00:00Z');
      const end = new Date(start.getTime() + (s.portMinutes ?? 0) * 60000);
      return priceLr(req.body.rateCard as RateCard, {
        jobType: s.jobType,
        from: s.from,
        to: s.to,
        containers: s.sizes.map((size, i) => ({
          number: `SAMPLE-${i + 1}`,
          size,
          state: s.state ?? 'loaded',
        })),
        timeline: { reach_pickup: { completed: start }, gate_out: { completed: end } },
      });
    },
  );
};

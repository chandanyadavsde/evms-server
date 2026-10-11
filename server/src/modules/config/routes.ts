import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { FlowDefinition } from '@vms/contracts';
import { lintFlow } from '../../domain/flow-lint';
import { buildScreen } from '../../domain/screen-builder';
import { requiredFields } from '../../domain/workflow';
import { recordEvent } from '../../lib/db-utils';
import { AppError, notFound } from '../../lib/errors';
import { publishFlow } from './service';

/**
 * Flow administration: list versions, validate, preview what each step looks like, publish a new
 * version (company, region or client scope), retire. Running legs keep the version they started on.
 */
export const configRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const db = app.db;
  const staff = app.auth('admin', 'manager');
  const admin = app.auth('admin');

  app.get('/v1/config/workflows', { preHandler: staff }, async (req) => {
    const rows = await db
      .selectFrom('config_definitions as d')
      .leftJoin('clients as c', 'c.id', 'd.client_id')
      .leftJoin('regions as r', 'r.id', 'd.region_id')
      .select([
        'd.id',
        'd.key',
        'd.version',
        'd.status',
        'd.published_at as publishedAt',
        'd.body',
        'c.name as clientName',
        'r.name as regionName',
      ])
      .where('d.kind', '=', 'workflow')
      .where((eb) => eb.or([eb('d.tenant_id', '=', req.user.tid), eb('d.tenant_id', 'is', null)]))
      .orderBy('d.key')
      .orderBy('d.version', 'desc')
      .execute();
    return rows.map(({ body, ...r }) => {
      const f = body as FlowDefinition;
      return {
        ...r,
        name: f.name,
        steps: f.steps.length,
        scope: r.clientName ?? r.regionName ?? 'Company',
      };
    });
  });

  app.get(
    '/v1/config/workflows/:id',
    { preHandler: staff, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } },
    async (req) => {
      const row = await db
        .selectFrom('config_definitions')
        .select(['id', 'body', 'status', 'version', 'client_id', 'region_id'])
        .where('id', '=', req.params.id)
        .where((eb) => eb.or([eb('tenant_id', '=', req.user.tid), eb('tenant_id', 'is', null)]))
        .executeTakeFirst();
      if (!row) throw notFound('Workflow');
      return row;
    },
  );

  /** Schema + reference checks, with readable errors. */
  app.post(
    '/v1/config/workflows/validate',
    { preHandler: staff, schema: { body: Type.Object({ flow: Type.Unknown() }) } },
    async (req) => {
      const schemaErrors = [...Value.Errors(FlowDefinition, req.body.flow)].map(
        (e) => `${e.path || '/'}: ${e.message}`,
      );
      const lintErrors = schemaErrors.length ? [] : lintFlow(req.body.flow as FlowDefinition);
      return { ok: !schemaErrors.length && !lintErrors.length, schemaErrors, lintErrors };
    },
  );

  /**
   * Simulation: every step as the driver/manager would see it, for a sample context
   * (e.g. a Nike 40ft container shows the extra EIR requirement).
   */
  app.post(
    '/v1/config/workflows/preview',
    {
      preHandler: staff,
      schema: {
        body: Type.Object({
          flow: Type.Unknown(),
          lang: Type.Optional(Type.String()),
          sample: Type.Optional(
            Type.Object({
              cargoSize: Type.Optional(Type.String()),
              clientCode: Type.Optional(Type.String()),
            }),
          ),
        }),
      },
    },
    async (req) => {
      if (!Value.Check(FlowDefinition, req.body.flow))
        throw new AppError(422, 'Flow does not match schema — validate first');
      const flow = req.body.flow;
      const lang = req.body.lang ?? 'en';
      const ctx = {
        cargo: { size: req.body.sample?.cargoSize ?? '20ft' },
        client: { code: req.body.sample?.clientCode ?? '' },
        vehicle: { lastOdometer: 0 },
        fields: {},
      };
      return flow.steps.map((step) => ({
        key: step.key,
        actor: step.actor,
        sla: step.sla ?? null,
        automations: step.onComplete ?? [],
        required: [...requiredFields(step, ctx)],
        screen: buildScreen({
          step,
          ctx,
          lang,
          info: { sample: `${ctx.cargo.size} · ${ctx.client.code || 'any client'}` },
        }),
      }));
    },
  );

  app.post(
    '/v1/config/workflows',
    {
      preHandler: admin,
      schema: {
        body: Type.Object({
          flow: Type.Unknown(),
          clientId: Type.Optional(Type.String({ format: 'uuid' })),
          regionId: Type.Optional(Type.String({ format: 'uuid' })),
        }),
      },
    },
    async (req, reply) => {
      const flow = req.body.flow as FlowDefinition;
      const scope = {
        ...(req.body.clientId ? { clientId: req.body.clientId } : {}),
        ...(req.body.regionId ? { regionId: req.body.regionId } : {}),
      };
      // A published version is immutable: changes need a higher version number.
      const latest = await db
        .selectFrom('config_definitions')
        .select(['version'])
        .where('tenant_id', '=', req.user.tid)
        .where('kind', '=', 'workflow')
        .where('key', '=', flow?.key ?? '')
        .where('client_id', scope.clientId ? '=' : 'is', scope.clientId ?? null)
        .where('region_id', scope.regionId ? '=' : 'is', scope.regionId ?? null)
        .orderBy('version', 'desc')
        .executeTakeFirst();
      if (latest && flow?.version <= latest.version) {
        throw new AppError(
          409,
          `Version ${flow.version} exists — publish as version ${latest.version + 1}`,
        );
      }
      const id = await publishFlow(db, req.user.tid, flow, scope);
      await recordEvent(db, {
        tenantId: req.user.tid,
        entity: 'config',
        entityId: id,
        type: 'workflow.published',
        actorId: req.user.sub,
        payload: { key: flow.key, version: flow.version, ...scope },
      });
      return reply.code(201).send({ id });
    },
  );

  app.post(
    '/v1/config/workflows/:id/retire',
    { preHandler: admin, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } },
    async (req) => {
      const r = await db
        .updateTable('config_definitions')
        .set({ status: 'retired' })
        .where('tenant_id', '=', req.user.tid)
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!r.numUpdatedRows) throw notFound('Workflow');
      await recordEvent(db, {
        tenantId: req.user.tid,
        entity: 'config',
        entityId: req.params.id,
        type: 'workflow.retired',
        actorId: req.user.sub,
      });
      return { ok: true };
    },
  );
};

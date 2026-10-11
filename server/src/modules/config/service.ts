import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { FlowDefinition } from '@vms/contracts';
import type { Db } from '../../db/client';
import { resolveDefinition, type ScopedDefinition } from '../../domain/config-resolution';
import { lintFlow } from '../../domain/flow-lint';
import { json } from '../../lib/db-utils';
import { AppError } from '../../lib/errors';

export interface ResolvedFlow {
  definitionId: string;
  flow: FlowDefinition;
}

/** Most specific published workflow for this tenant/region/client (see domain/config-resolution). */
export async function resolveWorkflow(
  db: Db,
  ctx: { key: string; tenantId: string; regionId: string; clientId: string | null },
): Promise<ResolvedFlow> {
  const rows = await db
    .selectFrom('config_definitions')
    .selectAll()
    .where('kind', '=', 'workflow')
    .where('key', '=', ctx.key)
    .where('status', '=', 'published')
    .where((eb) => eb.or([eb('tenant_id', 'is', null), eb('tenant_id', '=', ctx.tenantId)]))
    .execute();

  const candidates: ScopedDefinition<FlowDefinition>[] = rows.map((r) => ({
    id: r.id,
    key: r.key,
    version: r.version,
    status: r.status,
    tenantId: r.tenant_id,
    regionId: r.region_id,
    clientId: r.client_id,
    body: r.body as FlowDefinition,
  }));
  const chosen = resolveDefinition(candidates, {
    key: ctx.key,
    tenantId: ctx.tenantId,
    regionId: ctx.regionId,
    // A leg carrying several clients' cargo uses the company-level flow.
    clientId: ctx.clientId ?? '__none__',
  });
  if (!chosen) throw new AppError(422, `No published workflow "${ctx.key}"`);
  return { definitionId: chosen.id, flow: chosen.body };
}

export async function getFlow(db: Db, definitionId: string): Promise<FlowDefinition> {
  const row = await db
    .selectFrom('config_definitions')
    .select('body')
    .where('id', '=', definitionId)
    .executeTakeFirstOrThrow();
  return row.body as FlowDefinition;
}

/** Validates a flow and publishes it as a company-level definition (idempotent per version). */
export async function publishFlow(
  db: Db,
  tenantId: string,
  flow: unknown,
  scope: { regionId?: string; clientId?: string } = {},
): Promise<string> {
  const schemaErrors = [...Value.Errors(FlowDefinition, flow)].map(
    (e) => `${e.path}: ${e.message}`,
  );
  if (schemaErrors.length) throw new AppError(422, 'Flow does not match schema', schemaErrors);
  const def = flow as FlowDefinition;
  const lintErrors = lintFlow(def);
  if (lintErrors.length) throw new AppError(422, 'Flow has broken references', lintErrors);

  const existing = await db
    .selectFrom('config_definitions')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('kind', '=', 'workflow')
    .where('key', '=', def.key)
    .where('version', '=', def.version)
    .where('region_id', scope.regionId ? '=' : 'is', scope.regionId ?? null)
    .where('client_id', scope.clientId ? '=' : 'is', scope.clientId ?? null)
    .executeTakeFirst();
  if (existing) return existing.id;

  const row = await db
    .insertInto('config_definitions')
    .values({
      tenant_id: tenantId,
      region_id: scope.regionId ?? null,
      client_id: scope.clientId ?? null,
      kind: 'workflow',
      key: def.key,
      version: def.version,
      status: 'published',
      body: json(def),
      published_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function publishFlowsFromDir(
  db: Db,
  tenantId: string,
  dir: string,
): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    await publishFlow(db, tenantId, JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
  return files;
}

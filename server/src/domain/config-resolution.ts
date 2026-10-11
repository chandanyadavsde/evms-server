/**
 * Config resolution: pick the most specific published definition for a context.
 * Order (least -> most specific): platform, company, region, client, region+client.
 * The job type is part of the definition key, so it is matched exactly.
 */

export interface ScopedDefinition<T> {
  id: string;
  key: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  /** null = applies to all. tenantId null = platform default. */
  tenantId: string | null;
  regionId: string | null;
  clientId: string | null;
  body: T;
}

export interface ResolutionContext {
  key: string;
  tenantId: string;
  regionId: string;
  clientId: string;
}

function specificity(d: ScopedDefinition<unknown>): number {
  return (d.tenantId ? 1 : 0) + (d.regionId ? 2 : 0) + (d.clientId ? 4 : 0);
}

function applies(d: ScopedDefinition<unknown>, ctx: ResolutionContext): boolean {
  return (
    d.key === ctx.key &&
    d.status === 'published' &&
    (d.tenantId === null || d.tenantId === ctx.tenantId) &&
    (d.regionId === null || d.regionId === ctx.regionId) &&
    (d.clientId === null || d.clientId === ctx.clientId)
  );
}

export function resolveDefinition<T>(
  candidates: ScopedDefinition<T>[],
  ctx: ResolutionContext,
): ScopedDefinition<T> | undefined {
  return candidates
    .filter((d) => applies(d, ctx))
    .sort((a, b) => specificity(b) - specificity(a) || b.version - a.version)[0];
}

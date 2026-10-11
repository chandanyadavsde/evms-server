import { describe, expect, it } from 'vitest';
import { resolveDefinition, type ScopedDefinition } from '../src/domain/config-resolution';

const T = 'tenant-1';
const MUMBAI = 'region-mumbai';
const NIKE = 'client-nike';
const BAXI = 'client-baxi';

function def(
  id: string,
  scope: Partial<Pick<ScopedDefinition<null>, 'tenantId' | 'regionId' | 'clientId'>>,
  extra: Partial<ScopedDefinition<null>> = {},
): ScopedDefinition<null> {
  return {
    id,
    key: 'import_port_cfs',
    version: 1,
    status: 'published',
    tenantId: null,
    regionId: null,
    clientId: null,
    body: null,
    ...scope,
    ...extra,
  };
}

const ctx = { key: 'import_port_cfs', tenantId: T, regionId: MUMBAI, clientId: NIKE };

describe('resolveDefinition', () => {
  const all = [
    def('platform', {}),
    def('company', { tenantId: T }),
    def('mumbai', { tenantId: T, regionId: MUMBAI }),
    def('nike', { tenantId: T, clientId: NIKE }),
    def('nike-mumbai', { tenantId: T, regionId: MUMBAI, clientId: NIKE }),
    def('baxi', { tenantId: T, clientId: BAXI }),
  ];

  it('picks the most specific scope', () => {
    expect(resolveDefinition(all, ctx)?.id).toBe('nike-mumbai');
  });

  it('client beats region when there is no combined override', () => {
    const noCombo = all.filter((d) => d.id !== 'nike-mumbai');
    expect(resolveDefinition(noCombo, ctx)?.id).toBe('nike');
  });

  it('falls back to company, then platform', () => {
    expect(resolveDefinition(all, { ...ctx, regionId: 'other', clientId: 'new' })?.id).toBe(
      'company',
    );
    expect(resolveDefinition([def('platform', {})], ctx)?.id).toBe('platform');
  });

  it('never applies another client override', () => {
    expect(resolveDefinition([def('baxi', { tenantId: T, clientId: BAXI })], ctx)).toBeUndefined();
  });

  it('ignores drafts and picks the newest published version', () => {
    const versions = [
      def('v1', { tenantId: T }, { version: 1 }),
      def('v2', { tenantId: T }, { version: 2 }),
      def('v3-draft', { tenantId: T }, { version: 3, status: 'draft' }),
    ];
    expect(resolveDefinition(versions, ctx)?.id).toBe('v2');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizePortalUrl } from '../src/modules/admin/setup-routes';
import { makeTestApp } from './helpers';

describe('Phase 1 masters: ports, group codes, trip types, supervisors', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let admin: ReturnType<typeof t.call>;
  let manager: ReturnType<typeof t.call>;
  // biome-ignore lint/suspicious/noExplicitAny: API fixture
  let m: any;
  const place = (code: string) => m.locations.find((l: { code: string }) => l.code === code).id;

  beforeAll(async () => {
    t = await makeTestApp();
    admin = t.call(await t.login('admin@sorigin.co'));
    manager = t.call(await t.login('manager@sorigin.co'));
    m = (await admin.get('/v1/master')).json();
  });
  afterAll(async () => t.app.close());

  it('normalises portal addresses so any page under them matches', () => {
    expect(normalizePortalUrl('https://Portal.NSFT.com/eform13/?a=1')).toBe(
      'portal.nsft.com/eform13',
    );
  });

  it('lists ports with their portal address and group codes', async () => {
    const ports = (await manager.get('/v1/admin/ports')).json();
    const nsft = ports.find((p: { code: string }) => p.code === 'NSFT');
    expect(nsft.portal.urls).toEqual(['portal.nsft.com/eform13']);
    expect(nsft.groupCodes).toEqual([
      expect.objectContaining({ code: 'ULA', clientName: 'JM Baxi' }),
    ]);
    expect(ports.every((p: { code: string }) => !p.code.startsWith('CFS'))).toBe(true);
  });

  it('group codes are per port: the same code can mean another client on another port', async () => {
    const nike = m.clients.find((c: { code: string }) => c.code === 'NIKE').id;
    const ok = await admin.post(`/v1/admin/ports/${place('GTI')}/group-codes`, {
      code: 'ula',
      clientId: nike,
    });
    expect(ok.statusCode).toBe(201);
    const dup = await admin.post(`/v1/admin/ports/${place('GTI')}/group-codes`, {
      code: 'ULA',
      clientId: nike,
    });
    expect(dup.statusCode).toBe(409);
    const notPort = await admin.post(`/v1/admin/ports/${place('CFS-A')}/group-codes`, {
      code: 'X1',
      clientId: nike,
    });
    expect(notPort.statusCode).toBe(400);
    const byManager = await manager.post(`/v1/admin/ports/${place('GTI')}/group-codes`, {
      code: 'ZZ',
      clientId: nike,
    });
    expect(byManager.statusCode).toBe(403);
  });

  it('switches a trip type off', async () => {
    const types = (await admin.get('/v1/admin/trip-types')).json();
    const imp = types.find((x: { code: string }) => x.code === 'IMPORT_PORT_CFS');
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/v1/admin/trip-types/${imp.id}`,
      headers: { authorization: `Bearer ${await t.login('admin@sorigin.co')}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    const after = (await manager.get('/v1/master')).json();
    expect(after.jobTypes.find((j: { code: string }) => j.code === 'IMPORT_PORT_CFS').active).toBe(
      false,
    );
  });

  it('creates a supervisor and assigns ports and CFSs; other places are refused', async () => {
    const created = await admin.post('/v1/admin/users', {
      name: 'Sunil Supervisor',
      email: 'sunil@sorigin.co',
      role: 'manager',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const token = await t.login('admin@sorigin.co');
    const put = (locationIds: string[]) =>
      t.app.inject({
        method: 'PUT',
        url: `/v1/admin/users/${id}/places`,
        headers: { authorization: `Bearer ${token}` },
        payload: { locationIds },
      });
    expect((await put([place('NSFT'), place('CFS-A')])).json()).toMatchObject({ count: 2 });
    expect((await put([place('EY-1')])).statusCode).toBe(400);

    const users = (await admin.get('/v1/admin/users')).json();
    const sunil = users.find((u: { id: string }) => u.id === id);
    expect(sunil.places.map((p: { type: string }) => p.type).sort()).toEqual([
      'CFS',
      'PORT_TERMINAL',
    ]);
    // The new supervisor can sign in.
    expect(await t.login('sunil@sorigin.co')).toBeTruthy();
    const again = await admin.post('/v1/admin/users', {
      name: 'Dup',
      email: 'sunil@sorigin.co',
      role: 'manager',
    });
    expect(again.statusCode).toBe(409);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLOWS_DIR, makeTestApp } from './helpers';

type T = Awaited<ReturnType<typeof makeTestApp>>;

describe('M1: admin, flow publishing, exceptions, languages', () => {
  let t: T;
  let admin: ReturnType<T['call']>;
  let manager: ReturnType<T['call']>;
  // biome-ignore lint/suspicious/noExplicitAny: API fixture
  let master: any;
  const place = (code: string) =>
    master.locations.find((l: { code: string }) => l.code === code).id;

  beforeAll(async () => {
    t = await makeTestApp();
    admin = t.call(await t.login('admin@sorigin.co'));
    manager = t.call(await t.login('manager@sorigin.co'));
    master = (await manager.get('/v1/master')).json();
  });
  afterAll(() => t.app.close());

  it('admin onboards a client, place, truck and driver — no code change; managers cannot', async () => {
    expect(
      (await manager.post('/v1/admin/clients', { code: 'MAERSK', name: 'Maersk' })).statusCode,
    ).toBe(403);

    const client = await admin.post('/v1/admin/clients', {
      code: 'MAERSK',
      name: 'Maersk',
      lrPrefix: 'MSK/',
    });
    expect(client.statusCode, client.body).toBe(201);
    expect(
      (await admin.post('/v1/admin/clients', { code: 'MAERSK', name: 'Again' })).statusCode,
    ).toBe(409);

    const placeRes = await admin.post('/v1/admin/locations', {
      code: 'ICD-TKD',
      name: 'ICD Tughlakabad',
      typeCode: 'CFS',
      lat: 28.5,
      lng: 77.29,
      charging: { available: true, chargers: 2 },
    });
    expect(placeRes.statusCode, placeRes.body).toBe(201);

    const cats = (await admin.get('/v1/admin/vehicle-categories')).json();
    const truck = await admin.post('/v1/admin/vehicles', {
      regNo: 'mh46 ev 2001',
      categoryId: cats[0].id,
      soc: 90,
      odometer: 100,
    });
    expect(truck.statusCode, truck.body).toBe(201);

    const driver = await admin.post('/v1/admin/drivers', {
      name: 'New Driver',
      phone: '9000000099',
      language: 'mr',
    });
    expect(driver.statusCode, driver.body).toBe(201);
    // The new driver can sign in straight away.
    expect(await t.login('9000000099')).toBeTruthy();

    const m = (await manager.get('/v1/master')).json();
    expect(m.clients.map((c: { code: string }) => c.code)).toContain('MAERSK');
    expect(m.vehicles.map((v: { regNo: string }) => v.regNo)).toContain('MH46 EV 2001');
  });

  it('validates flows with readable errors', async () => {
    const res = await manager.post('/v1/config/workflows/validate', {
      flow: {
        key: 'x',
        name: 'X',
        version: 1,
        initialStep: 'nope',
        steps: [
          {
            key: 'a',
            title: 'A',
            actor: 'driver',
            fields: [],
            transitions: [{ action: 'go', label: 'Go', to: 'b' }],
          },
        ],
      },
    });
    expect(res.json()).toMatchObject({
      ok: false,
      lintErrors: expect.arrayContaining(['initialStep "nope" is not a step']),
    });
  });

  it('previews each step for a sample — Nike 40ft shows the EIR as required', async () => {
    const flow = JSON.parse(readFileSync(join(FLOWS_DIR, 'import_port_cfs.v2.json'), 'utf8'));
    const nike = (
      await manager.post('/v1/config/workflows/preview', {
        flow,
        sample: { cargoSize: '40ft', clientCode: 'NIKE' },
      })
    ).json();
    const other = (
      await manager.post('/v1/config/workflows/preview', {
        flow,
        sample: { cargoSize: '20ft', clientCode: 'JMB' },
      })
    ).json();
    const pickup = (r: { key: string; required: string[] }[]) =>
      r.find((s) => s.key === 'container_pickup')?.required;
    expect(pickup(nike)).toContain('eir_document');
    expect(pickup(other)).not.toContain('eir_document');
  });

  it('publishes a client-specific version; same version again is refused', async () => {
    const flow = JSON.parse(readFileSync(join(FLOWS_DIR, 'import_port_cfs.v2.json'), 'utf8'));
    const nikeId = master.clients.find((c: { code: string }) => c.code === 'NIKE').id;
    const first = await admin.post('/v1/config/workflows', {
      flow: { ...flow, version: 1 },
      clientId: nikeId,
    });
    expect(first.statusCode, first.body).toBe(201);
    const again = await admin.post('/v1/config/workflows', {
      flow: { ...flow, version: 1 },
      clientId: nikeId,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('version 2');
    const list = (await manager.get('/v1/config/workflows')).json();
    expect(list.some((w: { scope: string }) => w.scope === 'Nike')).toBe(true);
  });

  it('raises low-battery, SLA and cut-off exceptions with a proposal, and auto-resolves', async () => {
    const vehicle = master.vehicles.find((v: { regNo: string }) => v.regNo === 'MH46 EV 1004'); // 20ft truck, 47%
    const ids = (k: string) => master[k];
    const mv = await manager.post('/v1/moves', {
      clientId: ids('clients')[0].id,
      jobTypeId: ids('jobTypes').find((j: { code: string }) => j.code === 'IMPORT_PORT_CFS').id,
      containerNumber: 'CSQU3054383',
      cargoTypeId: ids('cargoTypes').find((c: { code: string }) => c.code === 'CONTAINER_20').id,
      fromLocationId: place('NSICT'),
      toLocationId: place('CFS-A'),
      cutoffAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(mv.statusCode).toBe(201);

    // Cut-off in 1 h and not yet planned → critical cut-off risk.
    await manager.post('/v1/exceptions/run', {});
    let open = (await manager.get('/v1/exceptions')).json();
    expect(open.find((e: { type: string }) => e.type === 'cutoff_risk')).toMatchObject({
      severity: 'critical',
      proposal: { action: 'plan_trip' },
    });

    // Plan it on a truck, then drain the battery and age the step past its SLA.
    const trip = await manager.post('/v1/trips', {
      vehicleId: vehicle.id,
      driverId: master.drivers[3].id,
      legs: [
        { fromLocationId: place('NSICT'), toLocationId: place('CFS-A'), moveIds: [mv.json().id] },
      ],
    });
    expect(trip.statusCode, trip.body).toBe(201);
    await t.db
      .updateTable('vehicles')
      .set({ last_soc_pct: 12 })
      .where('id', '=', vehicle.id)
      .execute();
    const legRow = await t.db
      .selectFrom('legs')
      .select('process_instance_id')
      .where('trip_id', '=', trip.json().id)
      .executeTakeFirstOrThrow();
    // Move the leg to the pickup step (SLA 120 min) and pretend it started 3 hours ago.
    await t.db
      .updateTable('process_instances')
      .set({
        current_step: 'container_pickup',
        step_entered_at: new Date(Date.now() - 3 * 3600000),
      })
      .where('id', '=', legRow.process_instance_id as string)
      .execute();

    await manager.post('/v1/exceptions/run', {});
    open = (await manager.get('/v1/exceptions')).json();
    const types = open.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['low_battery', 'sla_breach']));
    expect(open.find((e: { type: string }) => e.type === 'low_battery').severity).toBe('critical');
    expect(open.find((e: { type: string }) => e.type === 'sla_breach').message).toContain(
      '180 min',
    );
    // Once planned, the cut-off risk for a "pending" move becomes a "planned" one (still at risk).

    // Charging fixes the battery → that exception closes by itself.
    await t.db
      .updateTable('vehicles')
      .set({ last_soc_pct: 80 })
      .where('id', '=', vehicle.id)
      .execute();
    await manager.post('/v1/exceptions/run', {});
    open = (await manager.get('/v1/exceptions')).json();
    expect(open.map((e: { type: string }) => e.type)).not.toContain('low_battery');
  });

  it('manager dismisses an exception; it stays quiet', async () => {
    const open = (await manager.get('/v1/exceptions')).json();
    const sla = open.find((e: { type: string }) => e.type === 'sla_breach');
    expect(
      (await manager.post(`/v1/exceptions/${sla.id}/dismiss`, { note: 'Port congestion, known' }))
        .statusCode,
    ).toBe(200);
    await manager.post('/v1/exceptions/run', {});
    const after = (await manager.get('/v1/exceptions')).json();
    expect(after.map((e: { type: string }) => e.type)).not.toContain('sla_breach');
  });

  it('flags documents about to expire', async () => {
    const d = master.drivers[0];
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    expect(
      (
        await admin.post('/v1/admin/documents', {
          entity: 'driver',
          entityId: d.id,
          docType: 'port_pass',
          expiresAt: soon,
        })
      ).statusCode,
    ).toBe(201);
    await manager.post('/v1/exceptions/run', {});
    const open = (await manager.get('/v1/exceptions')).json();
    expect(open.find((e: { type: string }) => e.type === 'document_expiring')?.message).toContain(
      'port pass',
    );
  });

  it('driver errors come back in Hindi', async () => {
    // The driver planned on the SLA test (Hindi speaker).
    const driver = t.call(await t.login(master.drivers[3].phone));
    const trips = (await driver.get('/v1/driver/trips')).json();
    const legId = trips[0].legs[0].id;
    const res = await driver.post(`/v1/legs/${legId}/actions/confirm_pickup`, { values: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('कृपया लाल रंग वाले फ़ील्ड ठीक करें');
    expect(res.json().details[0].message).toBe('ज़रूरी है');
  });
});

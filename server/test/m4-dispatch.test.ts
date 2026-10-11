import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers';

type T = Awaited<ReturnType<typeof makeTestApp>>;

describe('M4/M5: smart dispatch, live fleet, shadow mode, driver shifts and GPS', () => {
  let t: T;
  let manager: ReturnType<T['call']>;
  // biome-ignore lint/suspicious/noExplicitAny: API fixture
  let m: any;
  const pick = (k: string, field: string, value: string) =>
    m[k].find((x: Record<string, string>) => x[field] === value).id;
  const newMove = async (
    container: string,
    job: string,
    size: string,
    from: string,
    to: string,
    client = 'JMB',
  ) => {
    const r = await manager.post('/v1/moves', {
      clientId: pick('clients', 'code', client),
      jobTypeId: pick('jobTypes', 'code', job),
      containerNumber: container,
      cargoTypeId: pick('cargoTypes', 'code', size),
      fromLocationId: pick('locations', 'code', from),
      toLocationId: pick('locations', 'code', to),
    });
    if (r.statusCode !== 201) throw new Error(r.body);
    return r.json().id as string;
  };

  beforeAll(async () => {
    t = await makeTestApp();
    manager = t.call(await t.login('manager@sorigin.co'));
    m = (await manager.get('/v1/master')).json();
  });
  afterAll(() => t.app.close());

  it('suggests trucks with reasons and explains every rejection', async () => {
    // Make one truck unusable two ways.
    await t.db
      .updateTable('vehicles')
      .set({ last_soc_pct: 5 })
      .where('reg_no', '=', 'MH46 EV 1005')
      .execute();
    const admin = t.call(await t.login('admin@sorigin.co'));
    await admin.post('/v1/admin/documents', {
      entity: 'vehicle',
      entityId: pick('vehicles', 'regNo', 'MH46 EV 1003'),
      docType: 'insurance',
      expiresAt: '2020-01-01',
    });

    const moveId = await newMove(
      'CSQU3054383',
      'IMPORT_PORT_CFS',
      'CONTAINER_40',
      'NSICT',
      'CFS-A',
    );
    const res = await manager.get(`/v1/dispatch/moves/${moveId}/suggestions`);
    expect(res.statusCode, res.body).toBe(200);
    const { suggestions, rejected } = res.json();
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].reasons.join(' ')).toMatch(/km empty to pickup|no empty running/);
    const why = Object.fromEntries(
      rejected.map((r: { regNo: string; reason: string }) => [r.regNo, r.reason]),
    );
    expect(why['MH46 EV 1003']).toBe('Truck insurance expired');
    expect(why['MH46 EV 1004']).toContain('Does not fit'); // 20ft truck, 40ft container
    expect(why['MH46 EV 1005']).toBeDefined(); // battery (or size) — never silently dropped
  });

  it('one click accepts the top suggestion: trip created (with a positioning leg) and choice logged', async () => {
    const moveId = (
      await t.db
        .selectFrom('moves')
        .select('id')
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow()
    ).id;
    const { suggestions } = (await manager.get(`/v1/dispatch/moves/${moveId}/suggestions`)).json();
    const top = suggestions[0];
    const res = await manager.post(`/v1/dispatch/moves/${moveId}/accept`, {
      vehicleId: top.vehicleId,
    });
    expect(res.statusCode, res.body).toBe(201);
    const trip = (await manager.get(`/v1/trips/${res.json().tripId}`)).json();
    // The truck starts at the charging hub, so an empty leg to the port comes first.
    expect(trip.legs.map((l: { kind: string }) => l.kind)).toEqual(['empty', 'loaded']);
    expect((await manager.get('/v1/dispatch/shadow-report')).json()).toMatchObject({
      decisions: 1,
      topPickRate: 100,
    });
  });

  it('spots a round-trip opportunity for a truck heading to the CFS, and appends the leg', async () => {
    const exportMove = await newMove(
      'MSKU9070323',
      'EXPORT_CFS_PORT',
      'CONTAINER_20',
      'CFS-A',
      'NSICT',
      'NIKE',
    );
    const opp = (await manager.get('/v1/dispatch/opportunities')).json();
    const found = opp.find((o: { moveId: string }) => o.moveId === exportMove);
    expect(found).toMatchObject({ kind: 'round_trip' });
    expect(found.reasons.join(' ')).toContain('round trip');

    const res = await manager.post(`/v1/dispatch/moves/${exportMove}/accept`, {
      vehicleId: found.vehicleId,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      action: 'append_leg',
      kind: 'round_trip',
      tripId: found.tripId,
    });
    const trip = (await manager.get(`/v1/trips/${found.tripId}`)).json();
    expect(
      trip.legs
        .map(
          (l: { from: { name: string }; to: { name: string } }) => `${l.from.name} → ${l.to.name}`,
        )
        .at(-1),
    ).toBe('CFS Alpha, Uran → NSICT (DP World)');
  });

  it('manager overriding the engine is recorded (shadow mode learns from it)', async () => {
    const moveId = await newMove('TGHU8791306', 'IMPORT_PORT_CFS', 'CONTAINER_20', 'GTI', 'CFS-B');
    const { suggestions } = (await manager.get(`/v1/dispatch/moves/${moveId}/suggestions`)).json();
    const notTop = [...suggestions]
      .reverse()
      .find(
        (x: { action: string; driverId: string | null }, i: number) =>
          x.action === 'new_trip' && x.driverId && i < suggestions.length - 1,
      );
    const planned = await manager.post('/v1/trips', {
      vehicleId: notTop.vehicleId,
      driverId: notTop.driverId,
      legs: [
        {
          fromLocationId: pick('locations', 'code', 'GTI'),
          toLocationId: pick('locations', 'code', 'CFS-B'),
          moveIds: [moveId],
        },
      ],
    });
    expect(planned.statusCode, planned.body).toBe(201);
    const report = (await manager.get('/v1/dispatch/shadow-report')).json();
    expect(report.decisions).toBe(3);
    expect(report.topPickRate).toBeLessThan(100);
  });

  it('driver shift start/end with readings, and GPS pings update the live map', async () => {
    const live0 = (await manager.get('/v1/fleet/live')).json();
    const busyDrivers = new Set(
      live0.fleet
        .filter((x: { tripId: string | null }) => x.tripId)
        .map((x: { driverId: string }) => x.driverId),
    );
    const freeDriver = m.drivers.find((d: { id: string }) => !busyDrivers.has(d.id));
    const freeTruck = live0.fleet.find(
      (x: { tripId: string | null; regNo: string }) => !x.tripId && x.regNo !== 'MH46 EV 1003',
    );
    const driver = t.call(await t.login(freeDriver.phone));
    const truck = freeTruck.vehicleId;
    const odo = Number(m.vehicles.find((v: { id: string }) => v.id === truck).odometer);
    // A driver on a trip cannot start a shift on some other truck.
    const busy = live0.fleet.find((x: { tripId: string | null }) => x.tripId);
    const busyDriver = t.call(
      await t.login(m.drivers.find((d: { id: string }) => d.id === busy.driverId).phone),
    );
    expect(
      (
        await busyDriver.post('/v1/driver/shift/start', {
          vehicleId: truck,
          odometer: odo + 1,
          soc: 80,
        })
      ).json().error,
    ).toContain('assigned to');
    expect(
      (await driver.post('/v1/driver/shift/start', { vehicleId: truck, odometer: 100, soc: 90 }))
        .statusCode,
    ).toBe(400); // below last reading
    expect(
      (
        await driver.post('/v1/driver/shift/start', {
          vehicleId: truck,
          odometer: odo + 10,
          soc: 90,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await driver.post('/v1/driver/location', { lat: 18.95, lng: 72.94, speedKmh: 22 })).json(),
    ).toEqual({ stored: true });

    const live = (await manager.get('/v1/fleet/live')).json();
    const v = live.fleet.find((x: { vehicleId: string }) => x.vehicleId === truck);
    expect(v).toMatchObject({
      positionSource: 'gps',
      position: { lat: 18.95, lng: 72.94 },
      soc: 90,
    });
    expect(live.places.length).toBeGreaterThan(3);

    expect(
      (await driver.post('/v1/driver/shift/end', { odometer: odo + 70, soc: 61 })).json(),
    ).toEqual({ ok: true, km: 60 });
  });

  it('fleet dashboard returns the economics (works on an empty history too)', async () => {
    const d = (await manager.get('/v1/dashboard/fleet?days=7')).json();
    expect(d).toMatchObject({ days: 7, shadow: { decisions: 3 } });
    expect(Array.isArray(d.trucks)).toBe(true);
  });
});

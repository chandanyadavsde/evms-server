import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers';

type T = Awaited<ReturnType<typeof makeTestApp>>;

describe('MVP flow: move → trip → driver steps → LR → round trip', () => {
  let t: T;
  let manager: ReturnType<T['call']>;
  let driver: ReturnType<T['call']>;
  let otherDriver: ReturnType<T['call']>;
  // biome-ignore lint/suspicious/noExplicitAny: test fixture of API response
  let master: any;
  let fileKey: string;

  const place = (code: string) =>
    master.locations.find((l: { code: string }) => l.code === code).id;
  const client = (code: string) => master.clients.find((c: { code: string }) => c.code === code).id;
  const job = (code: string) => master.jobTypes.find((j: { code: string }) => j.code === code).id;
  const cargo = (code: string) =>
    master.cargoTypes.find((c: { code: string }) => c.code === code).id;
  const vehicle = (reg: string) =>
    master.vehicles.find((v: { regNo: string }) => v.regNo === reg).id;
  const driverId = (name: string) =>
    master.drivers.find((d: { name: string }) => d.name === name).id;

  beforeAll(async () => {
    t = await makeTestApp();
    manager = t.call(await t.login('manager@sorigin.co'));
    const driverToken = await t.login('9000000001');
    driver = t.call(driverToken);
    fileKey = await t.upload(driverToken);
    otherDriver = t.call(await t.login('9000000002'));
    master = (await manager.get('/v1/master')).json();
  });
  afterAll(() => t.app.close());

  it('rejects a wrong OTP and unknown users get no hint', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { identifier: 'manager@sorigin.co', code: '000000' },
    });
    expect(res.statusCode).toBe(401);
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { identifier: 'nobody@x.com' },
    });
    expect(unknown.json()).toEqual({ sent: true });
  });

  it('blocks drivers from manager endpoints', async () => {
    expect((await driver.get('/v1/moves')).statusCode).toBe(403);
  });

  it('rejects a container number with a wrong check digit', async () => {
    const res = await manager.post('/v1/moves', {
      clientId: client('JMB'),
      jobTypeId: job('IMPORT_PORT_CFS'),
      containerNumber: 'CSQU3054384',
      cargoTypeId: cargo('CONTAINER_20'),
      fromLocationId: place('NSICT'),
      toLocationId: place('CFS-A'),
    });
    expect(res.statusCode).toBe(400);
  });

  let tripId: string;
  let legId: string;
  const moveIds: string[] = [];

  it('creates two 20ft import moves for two different clients', async () => {
    for (const [c, n] of [
      ['JMB', 'CSQU3054383'],
      ['NIKE', 'MSKU9070323'],
    ] as const) {
      const res = await manager.post('/v1/moves', {
        clientId: client(c),
        jobTypeId: job('IMPORT_PORT_CFS'),
        containerNumber: n,
        cargoTypeId: cargo('CONTAINER_20'),
        fromLocationId: place('NSICT'),
        toLocationId: place('CFS-A'),
      });
      expect(res.statusCode, res.body).toBe(201);
      moveIds.push(res.json().id);
    }
  });

  it('refuses a 40ft + 20ft on a 2-slot vehicle', async () => {
    const big = await manager.post('/v1/moves', {
      clientId: client('JMB'),
      jobTypeId: job('IMPORT_PORT_CFS'),
      containerNumber: 'TGHU8791306',
      cargoTypeId: cargo('CONTAINER_40'),
      fromLocationId: place('NSICT'),
      toLocationId: place('CFS-A'),
    });
    expect(big.statusCode, big.body).toBe(201);
    const res = await manager.post('/v1/trips', {
      vehicleId: vehicle('MH46 EV 1001'),
      driverId: driverId('Ramesh Patil'),
      legs: [
        {
          fromLocationId: place('NSICT'),
          toLocationId: place('CFS-A'),
          moveIds: [big.json().id, moveIds[0]],
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('needs 3 slots');
  });

  it('plans a trip with both 20ft on one leg → one Pre-LR per client', async () => {
    const res = await manager.post('/v1/trips', {
      vehicleId: vehicle('MH46 EV 1001'),
      driverId: driverId('Ramesh Patil'),
      legs: [{ fromLocationId: place('NSICT'), toLocationId: place('CFS-A'), moveIds }],
    });
    expect(res.statusCode, res.body).toBe(201);
    tripId = res.json().id;

    const trip = (await manager.get(`/v1/trips/${tripId}`)).json();
    expect(trip.legs).toHaveLength(1);
    legId = trip.legs[0].id;
    expect(trip.legs[0].lrs.map((l: { status: string }) => l.status)).toEqual(['pre_lr', 'pre_lr']);
    expect(trip.legs[0].currentStep).toBe('reach_pickup');
  });

  it('shows the driver their step in Hindi; other drivers are blocked', async () => {
    const res = await driver.get(`/v1/legs/${legId}/screen`);
    expect(res.statusCode).toBe(200);
    const { screen } = res.json();
    expect(screen.title).toBe('पोर्ट गेट पर पहुंचें');
    expect(screen.geoCheck).toMatchObject({ radiusM: 500 });
    expect((await otherDriver.get(`/v1/legs/${legId}/screen`)).statusCode).toBe(403);
  });

  it('blocks a step when evidence is missing', async () => {
    const res = await driver.post(`/v1/legs/${legId}/actions/reached_gate`, { values: {} });
    expect(res.statusCode).toBe(422);
    // Ramesh's saved language is Hindi, so the message is too.
    expect(res.json().details).toEqual([{ field: 'gate_in_photo', message: 'ज़रूरी है' }]);
  });

  it('runs the driver steps; LR is issued at pickup and odometer updates the vehicle', async () => {
    const act = (action: string, values: Record<string, unknown>) =>
      driver.post(`/v1/legs/${legId}/actions/${action}`, { values });

    expect((await act('reached_gate', { gate_in_photo: fileKey })).statusCode).toBe(200);

    const lowOdo = await act('confirm_pickup', {
      container_no: 'CSQU3054383',
      seal_photo: fileKey,
      port_receipt: fileKey,
      odometer: 100,
    });
    expect(lowOdo.statusCode).toBe(422);

    const pickup = await act('confirm_pickup', {
      container_no: 'CSQU3054383',
      seal_photo: fileKey,
      port_receipt: fileKey,
      odometer: 12460,
    });
    expect(pickup.statusCode, pickup.body).toBe(200);
    expect(pickup.json().screen.step).toBe('gate_out');

    const lrs = (await manager.get('/v1/lrs')).json();
    expect(lrs.map((l: { number: string }) => l.number).sort()).toEqual([
      'JMB/000001',
      'NKE/000001',
    ]);

    expect((await act('gate_out_done', { gate_out_slip: fileKey })).statusCode).toBe(200);
    expect((await act('reached_drop', {})).statusCode).toBe(200);
    const drop = await act('confirm_drop', {
      pod: fileKey,
      receiver_signature: fileKey,
      end_odometer: 12492,
      battery_soc: 58,
    });
    expect(drop.statusCode, drop.body).toBe(200);
    expect(drop.json().screen.step).toBe('manager_close');

    const v = (await manager.get('/v1/master'))
      .json()
      .vehicles.find((x: { regNo: string }) => x.regNo === 'MH46 EV 1001');
    expect(v).toMatchObject({ odometer: 12492, soc: 58 });
  });

  it('puts the manager step in the task queue; the driver cannot do it', async () => {
    const tasks = (await manager.get('/v1/tasks')).json();
    expect(tasks.map((x: { leg: { id: string } }) => x.leg.id)).toContain(legId);
    expect(
      (await driver.post(`/v1/legs/${legId}/actions/close_leg`, { values: {} })).statusCode,
    ).toBe(403);
  });

  it('turns the trip into a round trip before it closes (export back to port)', async () => {
    const exp = await manager.post('/v1/moves', {
      clientId: client('NIKE'),
      jobTypeId: job('EXPORT_CFS_PORT'),
      containerNumber: 'TGHU8791306',
      cargoTypeId: cargo('CONTAINER_40'),
      fromLocationId: place('CFS-A'),
      toLocationId: place('NSICT'),
    });
    expect(exp.statusCode).toBe(201);
    const res = await manager.post(`/v1/trips/${tripId}/legs`, {
      fromLocationId: place('CFS-A'),
      toLocationId: place('NSICT'),
      moveIds: [exp.json().id],
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('manager closes leg 1 → LRs closed, leg 2 becomes active, trip stays open', async () => {
    const res = await manager.post(`/v1/legs/${legId}/actions/close_leg`, {
      values: { remarks: 'ok' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().legStatus).toBe('completed');

    const trip = (await manager.get(`/v1/trips/${tripId}`)).json();
    expect(trip.status).toBe('active');
    expect(trip.legs.map((l: { status: string }) => l.status)).toEqual(['completed', 'active']);
    expect(trip.legs[0].lrs.every((l: { status: string }) => l.status === 'closed')).toBe(true);
    expect(trip.legs[1].currentStep).toBe('load_at_cfs');

    const driverTrips = (await driver.get('/v1/driver/trips')).json();
    expect(driverTrips[0].legs[1].status).toBe('active');
  });

  it('records every change in the event log', async () => {
    const events = (await manager.get(`/v1/trips/${tripId}/events`)).json();
    const types = events.map((e: { type: string }) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'trip.created',
        'leg.step_completed',
        'trip.leg_appended',
        'leg.completed',
      ]),
    );
  });
});

describe('evidence integrity', () => {
  it('refuses a file reference that this company did not upload', async () => {
    const t = await makeTestApp();
    const manager = t.call(await t.login('manager@sorigin.co'));
    // biome-ignore lint/suspicious/noExplicitAny: API fixture
    const m: any = (await manager.get('/v1/master')).json();
    const pick = (k: string, f: string, v: string) =>
      m[k].find((x: Record<string, string>) => x[f] === v).id;
    const mv = await manager.post('/v1/moves', {
      clientId: pick('clients', 'code', 'JMB'),
      jobTypeId: pick('jobTypes', 'code', 'IMPORT_PORT_CFS'),
      containerNumber: 'CSQU3054383',
      cargoTypeId: pick('cargoTypes', 'code', 'CONTAINER_20'),
      fromLocationId: pick('locations', 'code', 'NSICT'),
      toLocationId: pick('locations', 'code', 'CFS-A'),
    });
    const trip = await manager.post('/v1/trips', {
      vehicleId: pick('vehicles', 'regNo', 'MH46 EV 1002'),
      driverId: pick('drivers', 'name', 'Ramesh Patil'),
      legs: [
        {
          fromLocationId: pick('locations', 'code', 'NSICT'),
          toLocationId: pick('locations', 'code', 'CFS-A'),
          moveIds: [mv.json().id],
        },
      ],
    });
    const legId = (await manager.get(`/v1/trips/${trip.json().id}`)).json().legs[0].id;
    const res = await manager.post(`/v1/legs/${legId}/actions/reached_gate`, {
      values: { gate_in_photo: 'other-company/abc.jpg' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().details).toEqual([
      { field: 'gate_in_photo', message: 'Upload the file again' },
    ]);
    await t.app.close();
  });
});

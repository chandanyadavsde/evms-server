import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oauthHeader, processOutbox } from '../src/modules/billing/netsuite';
import { makeTestApp } from './helpers';

type T = Awaited<ReturnType<typeof makeTestApp>>;

describe('M2: rate cards, pricing on close, approval, NetSuite outbox', () => {
  let t: T;
  let manager: ReturnType<T['call']>;
  let driver: ReturnType<T['call']>;
  // biome-ignore lint/suspicious/noExplicitAny: API fixture
  let m: any;
  let legId: string;
  let lrId: string;
  const pick = (k: string, field: string, value: string) =>
    m[k].find((x: Record<string, string>) => x[field] === value).id;

  beforeAll(async () => {
    t = await makeTestApp();
    manager = t.call(await t.login('manager@sorigin.co'));
    const driverToken = await t.login('9000000001');
    driver = t.call(driverToken);
    const fileKey = await t.upload(driverToken);
    m = (await manager.get('/v1/master')).json();

    const move = await manager.post('/v1/moves', {
      clientId: pick('clients', 'code', 'JMB'),
      jobTypeId: pick('jobTypes', 'code', 'IMPORT_PORT_CFS'),
      containerNumber: 'TGHU8791306',
      cargoTypeId: pick('cargoTypes', 'code', 'CONTAINER_40'),
      fromLocationId: pick('locations', 'code', 'NSICT'),
      toLocationId: pick('locations', 'code', 'CFS-A'),
    });
    const trip = await manager.post('/v1/trips', {
      vehicleId: pick('vehicles', 'regNo', 'MH46 EV 1001'),
      driverId: pick('drivers', 'name', 'Ramesh Patil'),
      legs: [
        {
          fromLocationId: pick('locations', 'code', 'NSICT'),
          toLocationId: pick('locations', 'code', 'CFS-A'),
          moveIds: [move.json().id],
        },
      ],
    });
    legId = (await manager.get(`/v1/trips/${trip.json().id}`)).json().legs[0].id;

    const act = async (action: string, values: Record<string, unknown>) => {
      const r = await driver.post(`/v1/legs/${legId}/actions/${action}`, { values });
      if (r.statusCode !== 200) throw new Error(`${action}: ${r.body}`);
    };
    await act('reached_gate', { gate_in_photo: fileKey });
    await act('confirm_pickup', {
      container_no: 'TGHU8791306',
      seal_photo: fileKey,
      port_receipt: fileKey,
      odometer: 12500,
    });
    await act('gate_out_done', { gate_out_slip: fileKey });
    await act('reached_drop', {});
    await act('confirm_drop', {
      pod: fileKey,
      receiver_signature: fileKey,
      end_odometer: 12530,
      battery_soc: 60,
    });

    // Simulate 6 h 10 min between gate-in and gate-out (the test runs in milliseconds).
    const events = await t.db
      .selectFrom('events')
      .select(['id', 'payload'])
      .where('entity_id', '=', legId)
      .where('type', '=', 'leg.step_completed')
      .orderBy('id')
      .execute();
    const gateIn = events.find((e) => (e.payload as { step: string }).step === 'reach_pickup');
    const gateOut = events.find((e) => (e.payload as { step: string }).step === 'gate_out');
    const t0 = new Date(Date.now() - 8 * 3600000);
    await t.db
      .updateTable('events')
      .set({ created_at: t0 })
      .where('id', '=', gateIn?.id as string)
      .execute();
    await t.db
      .updateTable('events')
      .set({ created_at: new Date(t0.getTime() + 370 * 60000) })
      .where('id', '=', gateOut?.id as string)
      .execute();

    const close = await manager.post(`/v1/legs/${legId}/actions/close_leg`, { values: {} });
    if (close.statusCode !== 200) throw new Error(close.body);
    lrId = (await manager.get('/v1/lrs')).json()[0].id;
  });
  afterAll(() => t.app.close());

  it('prices the LR on close from the rate card: 40ft freight + detention', async () => {
    const lr = (await manager.get(`/v1/lrs/${lrId}`)).json();
    expect(lr.status).toBe('closed');
    expect(lr.rateCardKey).toBe('standard');
    expect(lr.charges.map((c: { code: string; amount: number }) => [c.code, c.amount])).toEqual([
      ['freight', 6500],
      ['detention', 1500],
    ]);
    expect(lr.total).toBe(8000);
    expect(lr.evidence.length).toBeGreaterThan(5);
  });

  it('manager adjusts a line and approves → billable, queued for NetSuite', async () => {
    const lr = (await manager.get(`/v1/lrs/${lrId}`)).json();
    const lines = lr.charges.map((c: { code: string; amount: number }) =>
      c.code === 'detention' ? { ...c, amount: 1000 } : c,
    );
    const res = await manager.post(`/v1/lrs/${lrId}/approve`, { lines });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'billable',
      total: 7500,
      outbox: { status: 'pending' },
    });
    expect(
      res.json().charges.find((c: { code: string }) => c.code === 'detention').adjustedBy,
    ).toBeTruthy();
    expect((await manager.post(`/v1/lrs/${lrId}/approve`, {})).statusCode).toBe(400); // only once
  });

  it('a failed push stays in the outbox with the reason', async () => {
    const r = await processOutbox(t.db, { mode: 'restlet' });
    expect(r).toEqual({ sent: 0, failed: 1 });
    const box = (await manager.get('/v1/billing/outbox')).json();
    expect(box.items[0]).toMatchObject({
      status: 'failed',
      last_error: 'NetSuite credentials are incomplete',
    });
  });

  it('retry in mock mode → LR pushed with a MOCK reference', async () => {
    const box = (await manager.get('/v1/billing/outbox')).json();
    expect(box.mode).toBe('mock');
    expect((await manager.post(`/v1/billing/outbox/${box.items[0].id}/retry`, {})).json()).toEqual({
      sent: 1,
      failed: 0,
    });
    const lr = (await manager.get(`/v1/lrs/${lrId}`)).json();
    expect(lr.status).toBe('pushed');
    expect(lr.netsuiteRef).toMatch(/^MOCK-INV-/);
  });

  it('quotes a rate card on a sample before publishing', async () => {
    const cards = (await manager.get('/v1/config/rate-cards')).json();
    const q = await manager.post('/v1/config/rate-cards/quote', {
      rateCard: cards[0].body,
      sample: {
        jobType: 'IMPORT_PORT_CFS',
        from: 'NSICT',
        to: 'CFS-A',
        sizes: ['20ft', '20ft'],
        portMinutes: 300,
      },
    });
    expect(q.json()).toMatchObject({ total: 9500, unpriced: [] }); // 2×4500 + 1 h detention
  });

  it('signs NetSuite requests with OAuth 1.0 HMAC-SHA256 (TBA)', () => {
    const h = oauthHeader(
      {
        account: '1234567_sb1',
        restletUrl: '',
        consumerKey: 'ck',
        consumerSecret: 'cs',
        tokenId: 'tk',
        tokenSecret: 'ts',
      },
      'POST',
      'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=1&deploy=1',
      'nonce',
      1700000000,
    );
    expect(h).toMatch(/^OAuth realm="1234567_SB1", oauth_consumer_key="ck", oauth_token="tk"/);
    expect(h).toContain('oauth_signature_method="HMAC-SHA256"');
    // Same inputs → same signature (deterministic).
    expect(h).toBe(
      oauthHeader(
        {
          account: '1234567_sb1',
          restletUrl: '',
          consumerKey: 'ck',
          consumerSecret: 'cs',
          tokenId: 'tk',
          tokenSecret: 'ts',
        },
        'POST',
        'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=1&deploy=1',
        'nonce',
        1700000000,
      ),
    );
  });
});

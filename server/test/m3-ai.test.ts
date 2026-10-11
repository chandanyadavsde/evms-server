import type { ExtractionResult, ExtractionTemplate } from '@vms/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Extractor, outputSchema, toResult } from '../src/modules/ai/extractor';
import { processPendingEvidence } from '../src/modules/ai/service';
import { makeTestApp } from './helpers';

/** Stands in for Claude in tests — no network, no cost. Returns whatever the test queues. */
class FakeExtractor implements Extractor {
  readonly model = 'fake-model';
  next: (t: ExtractionTemplate) => ExtractionResult = () => ({
    detectedAs: '',
    records: [],
    notes: '',
  });
  calls: string[] = [];
  async extract(t: ExtractionTemplate) {
    this.calls.push(t.key);
    return this.next(t);
  }
}

const tpl: ExtractionTemplate = {
  key: 'x',
  name: 'X',
  version: 1,
  kind: 'document',
  description: 'test',
  fields: [
    { key: 'container_number', label: 'Container', type: 'container_number' },
    { key: 'reading', label: 'Reading', type: 'number' },
  ],
};

describe('extractor output handling (no API calls)', () => {
  it('builds a strict schema: every field required, no extra properties', () => {
    const s = outputSchema(tpl) as {
      properties: { records: { items: { required: string[]; additionalProperties: boolean } } };
    };
    expect(s.properties.records.items.required).toEqual(['container_number', 'reading']);
    expect(s.properties.records.items.additionalProperties).toBe(false);
  });

  it('normalises values and distrusts a container number whose check digit fails', () => {
    const r = toResult(tpl, {
      detected_as: 'receipt',
      matches_template: true,
      notes: '',
      records: [
        {
          container_number: { value: 'csqu 305438-4', confidence: 0.95 },
          reading: { value: '12,460 km', confidence: 0.9 },
        },
      ],
    });
    expect(r.records[0]?.container_number).toMatchObject({
      value: 'CSQU3054384',
      confidence: 0.3,
      check: { ok: false },
    });
    expect(r.records[0]?.reading).toMatchObject({ value: 12460 });
  });

  it('returns nothing when the image is not the expected document', () => {
    const r = toResult(tpl, {
      detected_as: 'a selfie',
      matches_template: false,
      notes: '',
      records: [{} as never],
    });
    expect(r.records).toEqual([]);
  });
});

describe('M3: AI reading with review', () => {
  const fake = new FakeExtractor();
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let managerToken: string;
  let manager: ReturnType<typeof t.call>;
  // biome-ignore lint/suspicious/noExplicitAny: API fixture
  let m: any;
  const pick = (k: string, field: string, value: string) =>
    m[k].find((x: Record<string, string>) => x[field] === value).id;

  beforeAll(async () => {
    t = await makeTestApp({ extractor: fake });
    managerToken = await t.login('manager@sorigin.co');
    manager = t.call(managerToken);
    m = (await manager.get('/v1/master')).json();
  });
  afterAll(() => t.app.close());

  it('ships the extraction templates as configuration', async () => {
    const templates = (await manager.get('/v1/ai/templates')).json();
    expect(templates.map((x: { key: string }) => x.key).sort()).toEqual([
      'battery_soc',
      'gate_slip',
      'odometer',
      'port_receipt',
      'portal_container_status',
    ]);
    expect((await manager.get('/v1/ai/status')).json()).toEqual({
      enabled: true,
      model: 'fake-model',
    });
  });

  it('portal screenshot → matched to the move → confirmed → move gets portal status and cut-off', async () => {
    const move = await manager.post('/v1/moves', {
      clientId: pick('clients', 'code', 'NIKE'),
      jobTypeId: pick('jobTypes', 'code', 'IMPORT_PORT_CFS'),
      containerNumber: 'MSKU9070323',
      cargoTypeId: pick('cargoTypes', 'code', 'CONTAINER_20'),
      fromLocationId: pick('locations', 'code', 'NSICT'),
      toLocationId: pick('locations', 'code', 'CFS-A'),
    });
    fake.next = (template) =>
      toResult(template, {
        detected_as: 'NSICT container enquiry',
        matches_template: true,
        notes: '',
        records: [
          {
            container_number: { value: 'MSKU9070323', confidence: 0.97 },
            terminal: { value: 'NSICT', confidence: 0.9 },
            status: { value: 'Ready for delivery', confidence: 0.92 },
            yard_location: { value: 'B12-04-3', confidence: 0.8 },
            size_type: { value: '20GP', confidence: 0.9 },
            vessel: { value: '', confidence: 0 },
            hold_reason: { value: '', confidence: 0 },
            valid_till: { value: '2026-10-08T18:00', confidence: 0.85 },
          },
          {
            container_number: { value: 'TGHU8791306', confidence: 0.95 },
            terminal: { value: 'NSICT', confidence: 0.9 },
            status: { value: 'On hold', confidence: 0.9 },
            yard_location: { value: '', confidence: 0 },
            size_type: { value: '40HC', confidence: 0.9 },
            vessel: { value: '', confidence: 0 },
            hold_reason: { value: 'Customs', confidence: 0.8 },
            valid_till: { value: '', confidence: 0 },
          },
        ],
      });
    const fileKey = await t.upload(managerToken, 'portal.png');
    const ex = await manager.post('/v1/ai/extractions', {
      fileKey,
      templateKey: 'portal_container_status',
    });
    expect(ex.statusCode, ex.body).toBe(201);
    const body = ex.json();
    expect(body.status).toBe('done');
    expect(body.result.records).toHaveLength(2);
    expect(Object.keys(body.result.matches)).toEqual(['MSKU9070323']); // the other container has no move

    const records = body.result.records.map((r: Record<string, { value: unknown }>) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value])),
    );
    const confirm = await manager.post(`/v1/ai/extractions/${body.id}/confirm`, { records });
    expect(confirm.json().updatedMoves).toEqual([move.json().id]);

    const row = await t.db
      .selectFrom('moves')
      .select(['custom', 'cutoff_at'])
      .where('id', '=', move.json().id)
      .executeTakeFirstOrThrow();
    expect((row.custom as { portal: { status: string } }).portal.status).toBe('Ready for delivery');
    expect(row.cutoff_at?.toISOString().slice(0, 13)).toBe(
      new Date('2026-10-08T18:00').toISOString().slice(0, 13),
    );
  });

  it('driver uploads a port receipt → AI reads it in the background → mismatch raises an exception', async () => {
    const move = await manager.post('/v1/moves', {
      clientId: pick('clients', 'code', 'JMB'),
      jobTypeId: pick('jobTypes', 'code', 'IMPORT_PORT_CFS'),
      containerNumber: 'CSQU3054383',
      cargoTypeId: pick('cargoTypes', 'code', 'CONTAINER_20'),
      fromLocationId: pick('locations', 'code', 'NSICT'),
      toLocationId: pick('locations', 'code', 'CFS-A'),
    });
    const trip = await manager.post('/v1/trips', {
      vehicleId: pick('vehicles', 'regNo', 'MH46 EV 1002'),
      driverId: pick('drivers', 'name', 'Suresh Yadav'),
      legs: [
        {
          fromLocationId: pick('locations', 'code', 'NSICT'),
          toLocationId: pick('locations', 'code', 'CFS-A'),
          moveIds: [move.json().id],
        },
      ],
    });
    const legId = (await manager.get(`/v1/trips/${trip.json().id}`)).json().legs[0].id;
    const driverToken = await t.login('9000000002');
    const driver = t.call(driverToken);
    await driver.post(`/v1/legs/${legId}/actions/reached_gate`, {
      values: { gate_in_photo: await t.upload(driverToken) },
    });
    const pickup = await driver.post(`/v1/legs/${legId}/actions/confirm_pickup`, {
      values: {
        container_no: 'CSQU3054383',
        seal_photo: await t.upload(driverToken),
        port_receipt: await t.upload(driverToken, 'receipt.png'),
        odometer: 9900,
      },
    });
    expect(pickup.statusCode, pickup.body).toBe(200);

    // The receipt actually shows a different container.
    fake.calls = [];
    fake.next = (template) =>
      toResult(template, {
        detected_as: 'NSICT receipt',
        matches_template: true,
        notes: '',
        records: [
          {
            receipt_number: { value: 'R-889', confidence: 0.9 },
            container_number: { value: 'MSKU9070323', confidence: 0.96 },
            terminal: { value: 'NSICT', confidence: 0.9 },
            vehicle_number: { value: 'MH46 EV 1002', confidence: 0.9 },
            issued_at: { value: '', confidence: 0 },
            seal_number: { value: '', confidence: 0 },
          },
        ],
      });
    const r = await processPendingEvidence({ db: t.db, extractor: fake, filesDir: t.filesDir });
    expect(r.processed).toBe(1); // only the receipt is configured for AI reading
    expect(fake.calls).toEqual(['port_receipt']);

    const ex = (await manager.get('/v1/exceptions')).json();
    expect(ex.find((e: { type: string }) => e.type === 'document_mismatch')?.message).toContain(
      'document shows MSKU9070323, driver entered CSQU3054383',
    );
    // Engine checks must not auto-close AI findings.
    await manager.post('/v1/exceptions/run', {});
    expect(
      (await manager.get('/v1/exceptions'))
        .json()
        .some((e: { type: string }) => e.type === 'document_mismatch'),
    ).toBe(true);
  });

  it('without AI configured, the extraction fails gracefully with a clear message', async () => {
    const off = await makeTestApp({ extractor: null });
    const token = await off.login('manager@sorigin.co');
    const res = await off.call(token).post('/v1/ai/extractions', {
      fileKey: await off.upload(token),
      templateKey: 'port_receipt',
    });
    expect(res.json()).toMatchObject({
      status: 'failed',
      error: 'AI is not configured — enter the values manually',
    });
    await off.app.close();
  });
});

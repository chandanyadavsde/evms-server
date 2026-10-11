import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adaptValue, type FormField, guessDataKey, pageKey } from '../src/domain/form-fill';
import type { JsonRequest, VisionModel } from '../src/modules/ai/llm';
import { makeTestApp } from './helpers';

// The fields of an EFORM 13-style PIN form, as the plugin reports them.
const PIN_FORM: FormField[] = [
  { key: 'txtPinNo', label: 'PIN No', kind: 'text' },
  { key: 'txtTTNo', label: 'TT No', kind: 'text' },
  { key: 'txtBatNo', label: 'BAT No', kind: 'text' },
  { key: 'txtTruckCompany', label: 'Truck Company', kind: 'text' },
  { key: 'txtNoOfCont', label: 'No. Of Container', kind: 'number' },
  { key: 'txtMobile', label: 'Driver Mobile No', kind: 'text' },
  { key: 'ddlGroup', label: 'Group Code', kind: 'select', options: ['ULA', 'MSK'] },
  { key: 'ddlSize', label: 'Size', kind: 'select', options: ['Select', '20', '40', '45'] },
  { key: 'txtRfid', label: 'RF ID', kind: 'text' },
  { key: 'txtDL', label: 'Driving License No', kind: 'text' },
  { key: 'txtDriver', label: 'Driver Name', kind: 'text' },
];
const URL_ = 'https://portal.example.com/eform13/Import/CFSEForm13.aspx?x=1';

describe('smart paste rules', () => {
  it('maps portal labels to VMS data without an AI', () => {
    expect(Object.fromEntries(PIN_FORM.map((f) => [f.key, guessDataKey(f.label)]))).toEqual({
      txtPinNo: '',
      txtTTNo: 'truck_number',
      txtBatNo: '',
      txtTruckCompany: 'transporter',
      txtNoOfCont: 'container_count',
      txtMobile: 'driver_mobile',
      ddlGroup: '',
      ddlSize: 'container_size',
      txtRfid: '',
      txtDL: 'driver_licence',
      txtDriver: 'driver_name',
    });
  });

  it('formats values for the field: dropdown option, 10-digit mobile', () => {
    const size = PIN_FORM.find((f) => f.key === 'ddlSize') as FormField;
    expect(adaptValue(size, 'container_size', '20')).toMatchObject({ value: '20', status: 'fill' });
    expect(adaptValue(size, 'container_size', '30')).toMatchObject({ status: 'unknown' });
    const mobile = PIN_FORM.find((f) => f.key === 'txtMobile') as FormField;
    expect(adaptValue(mobile, 'driver_mobile', '+91 98765 43210').value).toBe('9876543210');
    expect(adaptValue(mobile, '', 'x')).toMatchObject({ status: 'unknown' });
  });

  it('learns per page, ignoring query strings', () => {
    expect(pageKey(URL_)).toBe('portal.example.com/eform13/import/cfseform13.aspx');
  });
});

describe('smart paste API', () => {
  /** Counts AI calls; answers like a model would. */
  const calls: JsonRequest[] = [];
  const model: VisionModel = {
    name: 'fake-ai',
    json: async (req) => {
      calls.push(req);
      return {
        fields: PIN_FORM.map((f) => ({ key: f.key, data_key: guessDataKey(f.label) })),
      };
    },
  };
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let manager: ReturnType<typeof t.call>;

  beforeAll(async () => {
    t = await makeTestApp({ model });
    manager = t.call(await t.login('manager@sorigin.co'));
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
      vehicleId: pick('vehicles', 'regNo', 'MH46 EV 1004'),
      driverId: pick('drivers', 'name', 'Ramesh Patil'),
      legs: [
        {
          fromLocationId: pick('locations', 'code', 'NSICT'),
          toLocationId: pick('locations', 'code', 'CFS-A'),
          moveIds: [mv.json().id],
        },
      ],
    });
    expect(trip.statusCode, trip.body).toBe(201);
  });
  afterAll(async () => t.app.close());

  it('lists planned jobs with the data a portal form needs', async () => {
    const sources = (await manager.get('/v1/assist/sources')).json();
    expect(sources).toHaveLength(1);
    expect(sources[0].data).toMatchObject({
      truck_number: 'MH46EV1004',
      driver_name: 'Ramesh Patil',
      container_count: '1',
      container_size: '20',
      container_numbers: 'CSQU3054383',
      client: 'JM Baxi',
      transporter: 'Skeiron Logistics',
    });
  });

  it('first fill asks the AI; after the manager fills, the page is learned (no AI)', async () => {
    const [source] = (await manager.get('/v1/assist/sources')).json();
    const first = await manager.post('/v1/assist/map', {
      url: URL_,
      fields: PIN_FORM,
      data: source.data,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ learned: false, by: 'fake-ai' });
    expect(calls).toHaveLength(1);
    const byKey = Object.fromEntries(
      first.json().values.map((v: { key: string; value: string }) => [v.key, v.value]),
    );
    expect(byKey).toMatchObject({
      txtTTNo: 'MH46EV1004',
      ddlSize: '20',
      txtNoOfCont: '1',
      txtDriver: 'Ramesh Patil',
      txtBatNo: '',
      ddlGroup: '',
    });

    const filled = await manager.post('/v1/assist/filled', {
      url: URL_,
      title: 'PIN Generation',
      legId: source.legId,
      fields: first.json().values.map((v: { key: string; dataKey: string }) => ({
        key: v.key,
        label: PIN_FORM.find((f) => f.key === v.key)?.label ?? '',
        dataKey: v.dataKey,
      })),
    });
    expect(filled.json()).toMatchObject({ ok: true });

    const again = await manager.post('/v1/assist/map', {
      url: `${URL_}&other=2`,
      fields: PIN_FORM,
      data: source.data,
    });
    expect(again.json()).toMatchObject({ learned: true, by: 'learned page' });
    expect(calls).toHaveLength(1);

    const pages = (await manager.get('/v1/assist/pages')).json();
    expect(pages[0]).toMatchObject({
      pageKey: 'portal.example.com/eform13/import/cfseform13.aspx',
      uses: 1,
    });
  });
});

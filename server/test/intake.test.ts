import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDraft, type IntakeMaster, matchName, type RawIntake } from '../src/domain/intake';
import { GeminiModel, ModelError, OpenRouterModel } from '../src/modules/ai/llm';
import type { IntakeReader } from '../src/modules/intake/reader';
import {
  findPendency,
  findSizeAndCount,
  findTime,
  RuleIntakeReader,
  readByRules,
} from '../src/modules/intake/rules';
import { makeTestApp } from './helpers';

const master: IntakeMaster = {
  clients: [
    { id: 'c-jmb', code: 'JMB', name: 'JM Baxi', aliases: ['ULA'] },
    { id: 'c-nike', code: 'NIKE', name: 'Nike', aliases: [] },
  ],
  locations: [
    {
      id: 'l-nsict',
      code: 'NSICT',
      name: 'NSICT (DP World)',
      type: 'PORT_TERMINAL',
      aliases: ['DPW'],
    },
    {
      id: 'l-gti',
      code: 'GTI',
      name: 'GTI (APM Terminals)',
      type: 'PORT_TERMINAL',
      aliases: ['APM'],
    },
    { id: 'l-cfsa', code: 'CFS-A', name: 'CFS Alpha, Uran', type: 'CFS', aliases: ['CFS Alpha'] },
  ],
  cargoTypes: [
    { id: 'ct-20', code: 'CONTAINER_20', name: '20ft container', size: '20ft' },
    { id: 'ct-40', code: 'CONTAINER_40', name: '40ft container', size: '40ft' },
  ],
  jobTypes: [
    {
      id: 'j-imp',
      code: 'IMPORT_PORT_CFS',
      name: 'Import: Port → CFS',
      fromType: 'PORT_TERMINAL',
      toType: 'CFS',
    },
    {
      id: 'j-exp',
      code: 'EXPORT_CFS_PORT',
      name: 'Export: CFS → Port',
      fromType: 'CFS',
      toType: 'PORT_TERMINAL',
    },
  ],
};
// 2026-10-08 09:00 in India
const now = new Date('2026-10-08T03:30:00Z');

const WHATSAPP =
  'Hi team, JM Baxi import 2x20 MSKU9070323 and CSQU3054383 from NSICT to CFS Alpha. Ready today 4pm, cut-off tomorrow 10:30';

const PENDENCY_OCR = `PIN Generation
Group Code: ULA   Container Type: Scan   Size: 20
ULA Pendency
Scan 20 40 45
Total Allocated Moves: 1 0 0
Generated PIN: 1 0 0
Balance: 0 0 0`;

describe('smart intake rules (free reader)', () => {
  it('reads sizes, counts and times the way people write them', () => {
    expect(findSizeAndCount('need 2x20 tomorrow')).toEqual({ size: '20', count: 2 });
    expect(findSizeAndCount("40' x 3 boxes")).toEqual({ size: '40', count: 3 });
    expect(findSizeAndCount('3 nos 20ft')).toEqual({ size: '20', count: 3 });
    expect(findSizeAndCount('one 40ft')).toEqual({ size: '40', count: 1 });
    expect(findTime('ready 4pm', now)).toBe('2026-10-08T16:00');
    expect(findTime('cut-off tomorrow 10:30', now)).toBe('2026-10-09T10:30');
    expect(findTime('kal 9 am', now)).toBe('2026-10-09T09:00');
    expect(findTime('by 12/10/2026 18:00', now)).toBe('2026-10-12T18:00');
  });

  it('turns a WhatsApp order into two complete draft moves', () => {
    const draft = buildDraft(readByRules(WHATSAPP, master, now), master);
    expect(draft.sourceKind).toBe('customer_order');
    expect(draft.moves).toHaveLength(2);
    const [a] = draft.moves;
    expect(a?.client).toMatchObject({ value: 'c-jmb', status: 'found' });
    expect(a?.from).toMatchObject({ value: 'l-nsict', status: 'found' });
    expect(a?.to).toMatchObject({ value: 'l-cfsa', status: 'found' });
    expect(a?.jobType).toMatchObject({ value: 'j-imp', status: 'found' });
    expect(a?.size).toMatchObject({ value: 'ct-20', status: 'found' });
    expect(a?.containerNumber).toMatchObject({ value: 'MSKU9070323', status: 'found' });
    expect(a?.readyAt.value).toBe('2026-10-08T10:30:00.000Z');
    expect(a?.cutoffAt.value).toBe('2026-10-09T05:00:00.000Z');
    expect(draft.questions).toEqual([]);
  });

  it('expands a count without numbers and asks for what is missing', () => {
    const draft = buildDraft(readByRules('3 x 40 to GTI please', master, now), master);
    expect(draft.moves).toHaveLength(3);
    expect(draft.moves[0]?.containerNumber.status).toBe('missing');
    expect(draft.moves[0]?.to).toMatchObject({ value: 'l-gti', status: 'found' });
    expect(draft.moves[0]?.client.status).toBe('missing');
    expect(draft.questions.join(' ')).toMatch(/Client: not clear/);
    expect(draft.questions.join(' ')).toMatch(/Pickup: not clear/);
  });

  it('does not let "2x20" swallow the container number after it', () => {
    const raw = readByRules(
      'import 2x20 MSKU9070323 & TGHU8791306 from DPW to CFS Alpha',
      master,
      now,
    );
    expect(raw.items.map((i) => i.container_number.value)).toEqual(['MSKU9070323', 'TGHU8791306']);
  });

  it('reads a portal pendency: balance 0 means nothing to plan', () => {
    const rows = findPendency(PENDENCY_OCR);
    expect(rows).toEqual([{ group: 'ULA', size: '20', allocated: '1', done: '1', balance: '0' }]);
    const draft = buildDraft(readByRules(PENDENCY_OCR, master, now), master);
    expect(draft.sourceKind).toBe('portal_pendency');
    expect(draft.moves).toHaveLength(0);
    expect(draft.questions[0]).toMatch(/ULA 20ft: balance 0/);
  });

  it('reads the exact page text the plugin sends (cells joined with |)', () => {
    const fromPlugin =
      'ULA | Pendency\nScan | 20 | 40 | 45\nTotal Allocated Moves: | 3 | 0 | 0\nGenerated PIN: | 1 | 0 | 0\nBalance: | 2 | 0 | 0';
    expect(findPendency(fromPlugin)).toEqual([
      { group: 'ULA', size: '20', allocated: '3', done: '1', balance: '2' },
    ]);
  });

  it('a pendency balance becomes draft moves for the mapped client', () => {
    const draft = buildDraft(
      readByRules(PENDENCY_OCR.replace('Balance: 0 0 0', 'Balance: 2 0 0'), master, now),
      master,
    );
    expect(draft.moves).toHaveLength(2);
    expect(draft.moves[0]?.client).toMatchObject({ value: 'c-jmb', label: 'JM Baxi' });
    expect(draft.moves[0]?.size.value).toBe('ct-20');
  });
});

describe('free OCR on screenshots', () => {
  const png = { data: Buffer.from(''), mediaType: 'image/png' as const };
  const readerFor = (text: string) => new RuleIntakeReader({ readText: async () => text });

  it('marks everything read from a screenshot as "please check"', async () => {
    const raw = await readerFor(WHATSAPP).read({ files: [png] }, master, now);
    const [m] = buildDraft(raw, master).moves;
    expect(m?.from).toMatchObject({ value: 'l-nsict', status: 'unsure' });
    expect(m?.containerNumber.status).toBe('unsure');
    expect(raw.notes).toMatch(/free OCR/);
  });

  it('does not invent an order from a pendency box it cannot read', async () => {
    // Real OCR of a phone photo of the NSFT screen: the numbers did not survive.
    const garbled =
      'APM Terminal -E.. @ :PSA-EFORM 135\nULA Pendency |\nContainer Type: 5 deal SM eated Moves: 18 so 9\nBalance:\n12:32';
    const draft = buildDraft(await readerFor(garbled).read({ files: [png] }, master, now), master);
    expect(draft.sourceKind).toBe('portal_pendency');
    expect(draft.moves).toHaveLength(0);
    expect(draft.notes).toMatch(/could not be read/);
  });
});

describe('checks after any reader', () => {
  it('on a portal page, moves come from the pendency balance only', () => {
    // What the AI returned for the real NSFT screenshot: pendency + an "order" from the PIN form.
    const item = Object.fromEntries(
      ['client', 'job_type', 'from', 'to', 'container_number', 'ready_at', 'cutoff_at'].map((k) => [
        k,
        { value: '', confidence: 0 },
      ]),
    );
    const draft = buildDraft(
      {
        source_kind: 'customer_order',
        detected_as: 'PIN Generation form',
        summary: '',
        notes: '',
        items: [
          {
            ...item,
            client: { value: 'ULA', confidence: 0.9 },
            size: { value: '20', confidence: 0.9 },
            count: { value: '1', confidence: 0.9 },
          } as RawIntake['items'][number],
        ],
        pendency: [
          { group: 'ULA', size: '20ft', allocated: '1', done: '1', balance: '0' },
          { group: 'ULA', size: '40ft', allocated: '0', done: '0', balance: '0' },
        ],
      },
      master,
    );
    expect(draft.sourceKind).toBe('portal_pendency');
    expect(draft.moves).toHaveLength(0);
    expect(draft.pendency).toHaveLength(1);
    expect(draft.questions).toEqual(['ULA 20ft: balance 0 — nothing left to plan.']);
  });

  it('matches names by alias, and is unsure when unclear', () => {
    expect(matchName('DPW', master.locations).item?.id).toBe('l-nsict');
    expect(matchName('nsict terminal gate 3', master.locations)).toMatchObject({ status: 'found' });
    expect(matchName('Some CFS', master.locations).status).toBe('unsure');
  });

  it('never marks a misread or low-confidence value as found', () => {
    const raw: RawIntake = {
      source_kind: 'customer_order',
      detected_as: 'WhatsApp',
      summary: '',
      pendency: [],
      notes: '',
      items: [
        {
          client: { value: 'JM Baxi', confidence: 0.4 },
          job_type: { value: '', confidence: 0 },
          from: { value: 'NSICT', confidence: 0.95 },
          to: { value: 'Mystery CFS', confidence: 0.9 },
          size: { value: '20', confidence: 0.9 },
          container_number: { value: 'CSQU3054384', confidence: 0.99 },
          count: { value: '1', confidence: 1 },
          ready_at: { value: 'evening', confidence: 0.5 },
          cutoff_at: { value: '', confidence: 0 },
        },
      ],
    };
    const [m] = buildDraft(raw, master).moves;
    expect(m?.client.status).toBe('unsure');
    expect(m?.to.status).toBe('unsure');
    expect(m?.containerNumber).toMatchObject({
      status: 'unsure',
      note: expect.stringMatching(/check digit/i),
    });
    expect(m?.readyAt.status).toBe('unsure');
    expect(m?.jobType.status).toBe('missing');
  });
});

describe('Gemini provider (no network)', () => {
  it('sends images inline with a JSON schema, without additionalProperties', async () => {
    let sent: { url: string; body: Record<string, unknown>; key: string } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      sent = {
        url,
        body: JSON.parse(String(init.body)),
        key: (init.headers as Record<string, string>)['x-goog-api-key'] as string,
      };
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
      );
    }) as typeof fetch;
    const g = new GeminiModel('gemini-flash-latest', 'k-123', fake);
    const out = await g.json({
      system: 'sys',
      parts: [{ data: Buffer.from('img'), mediaType: 'image/png' }, { text: 'hello' }],
      schema: { type: 'object', additionalProperties: false, properties: {} },
    });
    expect(out).toEqual({ ok: true });
    const s = sent as unknown as {
      url: string;
      key: string;
      body: {
        contents: { parts: { inlineData: { mimeType: string } }[] }[];
        generationConfig: { responseJsonSchema: unknown };
      };
    };
    expect(s.url).toContain('models/gemini-flash-latest:generateContent');
    expect(s.key).toBe('k-123');
    expect(s.url).not.toContain('k-123');
    expect(s.body.contents[0]?.parts[0]?.inlineData.mimeType).toBe('image/png');
    expect(s.body.generationConfig.responseJsonSchema).toEqual({ type: 'object', properties: {} });
  });

  it('explains a free-tier quota error', async () => {
    const fake = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    const g = new GeminiModel('m', 'k', fake);
    await expect(g.json({ system: '', parts: [], schema: {} })).rejects.toThrow(ModelError);
  });
});

describe('OpenRouter provider (no network)', () => {
  it('sends a strict JSON schema and the image as a data URL, and adds up the cost', async () => {
    const calls: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      calls.push({
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3000, completion_tokens: 400, cost: 0.00046 },
        }),
      );
    }) as typeof fetch;
    const m = new OpenRouterModel('google/gemini-2.5-flash-lite', 'sk-or-1', fake);
    const req = {
      system: 'sys',
      parts: [{ data: Buffer.from('img'), mediaType: 'image/png' as const }, { text: 'hi' }],
      schema: { type: 'object' },
    };
    expect(await m.json(req)).toEqual({ ok: true });
    await m.json(req);
    expect(m.spentUsd).toBeCloseTo(0.00092);
    const sent = calls[0] as (typeof calls)[number];
    expect(sent.headers.authorization).toBe('Bearer sk-or-1');
    expect(sent.body).toMatchObject({
      model: 'google/gemini-2.5-flash-lite',
      response_format: { type: 'json_schema', json_schema: { strict: true } },
      provider: { require_parameters: true },
    });
    const content = (sent.body.messages as { content: unknown }[])[1]?.content as {
      image_url?: { url: string };
    }[];
    expect(content[0]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it('says plainly when the credit is used up', async () => {
    const fake = (async () => new Response('{}', { status: 402 })) as unknown as typeof fetch;
    const m = new OpenRouterModel('m', 'k', fake);
    await expect(m.json({ system: '', parts: [], schema: {} })).rejects.toThrow(/credit/);
  });
});

describe('intake API: read → review → confirm', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let manager: ReturnType<typeof t.call>;
  beforeAll(async () => {
    t = await makeTestApp();
    manager = t.call(await t.login('manager@sorigin.co'));
  });
  afterAll(async () => t.app.close());

  it('reports which reader is active', async () => {
    const res = await manager.get('/v1/intake/status');
    expect(res.json()).toMatchObject({ reader: 'rules (text only)', readsImages: false });
  });

  it('reads a pasted message, then creates linked moves on confirm', async () => {
    const read = await manager.post('/v1/intake/read', { text: WHATSAPP, fileKeys: [] });
    expect(read.statusCode).toBe(201);
    const { id, draft } = read.json();
    expect(draft.moves).toHaveLength(2);
    expect(draft.moves[0].client.status).toBe('found');

    const moves = draft.moves.map((m: Record<string, { value: string | null }>) => ({
      clientId: m.client?.value,
      jobTypeId: m.jobType?.value,
      cargoTypeId: m.size?.value,
      fromLocationId: m.from?.value,
      toLocationId: m.to?.value,
      containerNumber: m.containerNumber?.value ?? undefined,
      readyAt: m.readyAt?.value ?? undefined,
    }));
    const ok = await manager.post(`/v1/intake/${id}/confirm`, { moves });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().moveIds).toHaveLength(2);

    const again = await manager.post(`/v1/intake/${id}/confirm`, { moves });
    expect(again.statusCode).toBe(400);

    // Reading the same message again flags the duplicates.
    const dup = (await manager.post('/v1/intake/read', { text: WHATSAPP, fileKeys: [] })).json();
    expect(dup.draft.moves[0].duplicateOf).toBe(ok.json().moveIds[0]);
  });

  it('creates a move without a container number and fills it in later', async () => {
    const read = (
      await manager.post('/v1/intake/read', {
        text: '1 x 20 from NSICT to CFS Alpha for Nike',
        fileKeys: [],
      })
    ).json();
    const m = read.draft.moves[0];
    expect(m.containerNumber.status).toBe('missing');
    const ok = await manager.post(`/v1/intake/${read.id}/confirm`, {
      moves: [
        {
          clientId: m.client.value,
          jobTypeId: m.jobType.value,
          cargoTypeId: m.size.value,
          fromLocationId: m.from.value,
          toLocationId: m.to.value,
        },
      ],
    });
    const moveId = ok.json().moveIds[0];
    const listed = (await manager.get('/v1/moves'))
      .json()
      .find((x: { id: string }) => x.id === moveId);
    expect(listed.containerNumber).toBeNull();

    const bad = await manager.post(`/v1/moves/${moveId}/container`, {
      containerNumber: 'TGHU8791307',
    });
    expect(bad.statusCode).toBe(400);
    const set = await manager.post(`/v1/moves/${moveId}/container`, {
      containerNumber: 'TGHU8791306',
    });
    expect(set.json()).toMatchObject({ ok: true, containerNumber: 'TGHU8791306' });
  });

  it('rejects an invalid container number on confirm before creating anything', async () => {
    const read = (
      await manager.post('/v1/intake/read', { text: '1x40 GTI to CFS Alpha JM Baxi', fileKeys: [] })
    ).json();
    const m = read.draft.moves[0];
    const res = await manager.post(`/v1/intake/${read.id}/confirm`, {
      moves: [
        {
          clientId: m.client.value,
          jobTypeId: m.jobType.value,
          cargoTypeId: m.size.value,
          fromLocationId: m.from.value,
          toLocationId: m.to.value,
          containerNumber: 'CSQU3054384',
        },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().details[0].field).toBe('moves.0.containerNumber');
  });

  it('records the page a plugin copy came from', async () => {
    const source = {
      kind: 'plugin',
      url: 'https://portal.example.com/eform13/pin',
      title: 'PIN Generation',
    };
    const read = await manager.post('/v1/intake/read', {
      text: 'Text on the page inside the copied area:\n1 x 20 from NSICT to CFS Alpha for Nike',
      fileKeys: [],
      source,
    });
    expect(read.statusCode).toBe(201);
    expect((await manager.get(`/v1/intake/${read.json().id}`)).json().source).toEqual(source);
    const row = (await manager.get('/v1/intake'))
      .json()
      .find((r: { id: string }) => r.id === read.json().id);
    expect(row).toMatchObject({ source, preview: '1 x 20 from NSICT to CFS Alpha for Nike' });
  });

  it('explains when images cannot be read on this server', async () => {
    const key = await t.upload(await t.login('manager@sorigin.co'));
    const res = await manager.post('/v1/intake/read', { fileKeys: [key] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/paste the message text/);
    const list = (await manager.get('/v1/intake')).json();
    expect(list[0]).toMatchObject({ status: 'failed' });
  });
});

describe('intake API with an AI reader (fake, no network)', () => {
  it('uses the reader for screenshots and keeps the provider name', async () => {
    const reader: IntakeReader = {
      name: 'fake-ai',
      readsImages: true,
      read: async () => ({
        source_kind: 'portal_pendency',
        detected_as: 'NSFT EFORM 13 pendency',
        summary: 'ULA has 1×20 allocated, all PINs made',
        items: [],
        pendency: [{ group: 'ULA', size: '20', allocated: '1', done: '1', balance: '0' }],
        notes: '',
      }),
    };
    const t = await makeTestApp({ intakeReader: reader });
    const token = await t.login('manager@sorigin.co');
    const key = await t.upload(token);
    const res = await t.call(token).post('/v1/intake/read', { fileKeys: [key] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      provider: 'fake-ai',
      draft: { sourceKind: 'portal_pendency', moves: [] },
    });
    await t.app.close();
  });
});

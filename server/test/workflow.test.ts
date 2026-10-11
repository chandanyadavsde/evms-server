import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { FlowDefinition, Screen } from '@vms/contracts';
import { describe, expect, it } from 'vitest';
import { lintFlow } from '../src/domain/flow-lint';
import { buildScreen } from '../src/domain/screen-builder';
import { findStep, performAction } from '../src/domain/workflow';

const flowsDir = join(import.meta.dirname, '..', '..', 'config', 'flows');
const load = (file: string) => JSON.parse(readFileSync(join(flowsDir, file), 'utf8'));

describe('config/flows files', () => {
  for (const file of readdirSync(flowsDir).filter((f) => f.endsWith('.json'))) {
    it(`${file} matches the FlowDefinition schema and lints clean`, () => {
      const flow = load(file);
      const schemaErrors = [...Value.Errors(FlowDefinition, flow)].map(
        (e) => `${e.path}: ${e.message}`,
      );
      expect(schemaErrors).toEqual([]);
      expect(lintFlow(flow)).toEqual([]);
    });
  }
});

describe('import_port_cfs workflow', () => {
  const flow: FlowDefinition = load('import_port_cfs.v2.json');
  const ctx = {
    cargo: { size: '20ft' },
    client: { code: 'BAXI' },
    vehicle: { lastOdometer: 1000 },
  };
  const pickup = {
    container_no: 'CSQU3054383',
    seal_photo: 'evidence/1.jpg',
    port_receipt: 'evidence/2.pdf',
    odometer: 1012,
  };

  it('moves to gate_out when all required pickup evidence is present', () => {
    const r = performAction(flow, 'container_pickup', 'confirm_pickup', ctx, pickup);
    expect(r).toMatchObject({ ok: true, nextStep: 'gate_out' });
    if (r.ok) expect(r.automations).toEqual([{ type: 'lr.issue' }]);
  });

  it('blocks pickup when the seal photo is missing', () => {
    const r = performAction(flow, 'container_pickup', 'confirm_pickup', ctx, {
      ...pickup,
      seal_photo: '',
    });
    expect(r).toEqual({ ok: false, errors: [{ field: 'seal_photo', message: 'Required' }] });
  });

  it('rejects an odometer lower than the last reading', () => {
    const r = performAction(flow, 'container_pickup', 'confirm_pickup', ctx, {
      ...pickup,
      odometer: 900,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe('odometer');
  });

  it('requires EIR only for Nike 40ft containers', () => {
    const nike40 = { ...ctx, cargo: { size: '40ft' }, client: { code: 'NIKE' } };
    const r = performAction(flow, 'container_pickup', 'confirm_pickup', nike40, pickup);
    expect(r).toEqual({ ok: false, errors: [{ field: 'eir_document', message: 'Required' }] });

    const ok = performAction(flow, 'container_pickup', 'confirm_pickup', nike40, {
      ...pickup,
      eir_document: 'evidence/3.pdf',
    });
    expect(ok.ok).toBe(true);
  });

  it('lets report_issue through without validation', () => {
    const r = performAction(flow, 'container_pickup', 'report_issue', ctx, {});
    expect(r).toMatchObject({ ok: true, nextStep: 'container_pickup' });
  });

  it('rejects actions the step does not allow', () => {
    const r = performAction(flow, 'container_pickup', 'close_leg', ctx, pickup);
    expect(r.ok).toBe(false);
  });

  it('checks end odometer against pickup odometer from earlier step', () => {
    const dropCtx = { ...ctx, fields: { odometer: 1012 } };
    const input = { pod: 'evidence/9.pdf', receiver_signature: 'evidence/10.png', battery_soc: 60 };
    expect(
      performAction(flow, 'drop', 'confirm_drop', dropCtx, { ...input, end_odometer: 1000 }).ok,
    ).toBe(false);
    expect(
      performAction(flow, 'drop', 'confirm_drop', dropCtx, { ...input, end_odometer: 1040 }).ok,
    ).toBe(true);
  });

  it('builds a valid Hindi screen for the pickup step', () => {
    const screen = buildScreen({
      step: findStep(flow, 'container_pickup'),
      ctx,
      lang: 'hi',
      info: { container: 'CSQU3054383', size: '20ft' },
    });
    expect([...Value.Errors(Screen, screen)]).toEqual([]);
    expect(screen.title).toBe('कंटेनर उठाएं');
    expect(screen.components[0]).toMatchObject({ type: 'info_card' });
    expect(screen.components.find((c) => 'key' in c && c.key === 'eir_document')).toMatchObject({
      required: false,
    });
    expect(screen.actions.map((a) => a.id)).toEqual(['confirm_pickup', 'report_issue']);
  });
});

describe('lintFlow', () => {
  it('catches broken references', () => {
    const broken: FlowDefinition = {
      key: 'broken',
      name: 'Broken',
      version: 1,
      initialStep: 'missing',
      steps: [
        {
          key: 'a',
          title: 'A',
          actor: 'driver',
          fields: [],
          conditions: [{ if: true, require: ['ghost'] }],
          transitions: [{ action: 'go', label: 'Go', to: 'nowhere' }],
        },
      ],
    };
    expect(lintFlow(broken)).toEqual([
      'initialStep "missing" is not a step',
      'a: condition requires unknown field "ghost"',
      'a.go: transition to unknown step "nowhere"',
      'no transition reaches "end"',
    ]);
  });
});

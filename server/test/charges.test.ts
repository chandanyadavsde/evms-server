import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { RateCard } from '@vms/contracts';
import { describe, expect, it } from 'vitest';
import { priceLr } from '../src/domain/charges';

const card: RateCard = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'config', 'rate-cards', 'standard.v1.json'),
    'utf8',
  ),
);
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 7, h, m));
const base = { jobType: 'IMPORT_PORT_CFS', from: 'NSICT', to: 'CFS-A' };

describe('priceLr', () => {
  it('the shipped rate card matches its schema', () => {
    expect([...Value.Errors(RateCard, card)]).toEqual([]);
  });

  it('prices 2x20ft loaded with no detention inside the free time', () => {
    const r = priceLr(card, {
      ...base,
      containers: [
        { number: 'A', size: '20ft', state: 'loaded' },
        { number: 'B', size: '20ft', state: 'loaded' },
      ],
      timeline: { reach_pickup: { completed: at(9) }, gate_out: { completed: at(12) } },
    });
    expect(r.lines.map((l) => l.amount)).toEqual([4500, 4500]);
    expect(r.total).toBe(9000);
    expect(r.unpriced).toEqual([]);
  });

  it('uses the most specific line (empty 40ft beats 40ft)', () => {
    const r = priceLr(card, {
      ...base,
      containers: [{ number: 'E', size: '40ft', state: 'empty' }],
      timeline: {},
    });
    expect(r.lines[0]).toMatchObject({ amount: 4200, label: 'Freight 40ft empty · E' });
  });

  it('charges detention per started hour after the free 4 hours', () => {
    // Gate-in 09:00, gate-out 15:10 → 370 min, 130 chargeable → 3 started hours × 500.
    const r = priceLr(card, {
      ...base,
      containers: [{ number: 'A', size: '40ft', state: 'loaded' }],
      timeline: { reach_pickup: { completed: at(9) }, gate_out: { completed: at(15, 10) } },
    });
    const det = r.lines.find((l) => l.code === 'detention');
    expect(det).toMatchObject({ quantity: 3, rate: 500, amount: 1500 });
    expect(det?.basis).toContain('370 min');
    expect(r.total).toBe(8000);
  });

  it('reports containers no line covers', () => {
    const r = priceLr(card, {
      ...base,
      containers: [{ number: 'X', size: '45ft', state: 'loaded' }],
      timeline: {},
    });
    expect(r.unpriced).toEqual(['X']);
  });

  it('labels in Hindi for Hindi users', () => {
    const r = priceLr(
      card,
      { ...base, containers: [{ number: 'A', size: '20ft', state: 'loaded' }], timeline: {} },
      'hi',
    );
    expect(r.lines[0]?.label).toBe('भाड़ा 20 फुट · A');
  });
});

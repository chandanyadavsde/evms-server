import { describe, expect, it } from 'vitest';
import { checkCapacity } from '../src/domain/capacity';

const c20 = { slots: 1 };
const c40 = { slots: 2 };
const trailer40 = { slots: 2 };

describe('checkCapacity', () => {
  it('fits 2x20ft on a 40ft vehicle', () => {
    expect(checkCapacity(trailer40, [], [c20, c20])).toMatchObject({
      ok: true,
      free: { slots: 0 },
    });
  });

  it('fits 1x40ft on a 40ft vehicle', () => {
    expect(checkCapacity(trailer40, [], [c40]).ok).toBe(true);
  });

  it('rejects 40ft + 20ft on a 40ft vehicle', () => {
    const r = checkCapacity(trailer40, [c40], [c20]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('needs 3 slots but vehicle has 2');
  });

  it('rejects 40ft on a 20ft vehicle', () => {
    expect(checkCapacity({ slots: 1 }, [], [c40]).ok).toBe(false);
  });

  it('reports one free slot with a single 20ft aboard (consolidation)', () => {
    expect(checkCapacity(trailer40, [c20]).free.slots).toBe(1);
  });

  it('checks every dimension the vehicle limits', () => {
    const limits = { slots: 2, weight_kg: 30000 };
    const heavy20 = { slots: 1, weight_kg: 24000 };
    const r = checkCapacity(limits, [heavy20], [heavy20]);
    expect(r).toMatchObject({ ok: false, reason: 'needs 48000 weight_kg but vehicle has 30000' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  type FleetSlot,
  type MoveToPlace,
  straightKm,
  suggestVehicles,
} from '../src/domain/dispatch';
import { DEFAULT_SETTINGS } from '../src/lib/settings';

const NSICT = { id: 'nsict', name: 'NSICT', lat: 18.9489, lng: 72.9425 };
const CFS = { id: 'cfs', name: 'CFS Alpha', lat: 18.8902, lng: 72.9564 };
const FAR = { id: 'far', name: 'Far depot', lat: 19.2, lng: 73.1 };
const now = new Date('2026-10-07T08:00:00Z');
const policy = DEFAULT_SETTINGS.dispatch;

const move: MoveToPlace = {
  id: 'm1',
  container: 'MSKU9070323',
  from: NSICT,
  to: CFS,
  uses: { slots: 1 },
  cutoffAt: null,
};

const slot = (over: Partial<FleetSlot>): FleetSlot => ({
  vehicleId: 'v',
  regNo: 'V',
  capacity: { slots: 2 },
  batteryKwh: 282,
  freeAt: now,
  freeAt_place: CFS,
  freeSocPct: 80,
  driverId: 'd',
  driverName: 'Driver',
  tripId: null,
  endsEmpty: false,
  legsToday: 0,
  blockers: [],
  ...over,
});

describe('suggestVehicles', () => {
  it('distance sanity: NSICT to CFS Alpha is ~6.6 km straight', () => {
    expect(straightKm(NSICT, CFS)).toBeGreaterThan(6);
    expect(straightKm(NSICT, CFS)).toBeLessThan(7.5);
  });

  it('prefers the truck already finishing at the port (round trip) over an idle truck far away', () => {
    const r = suggestVehicles(
      move,
      [
        slot({ vehicleId: 'far', regNo: 'FAR', freeAt_place: FAR }),
        slot({
          vehicleId: 'rt',
          regNo: 'ROUND',
          freeAt_place: NSICT,
          freeAt: new Date(now.getTime() + 20 * 60000),
          tripId: 't1',
          freeSocPct: 60,
        }),
      ],
      [CFS],
      policy,
      now,
    );
    expect(r.suggestions[0]).toMatchObject({
      regNo: 'ROUND',
      kind: 'round_trip',
      action: 'append_leg',
      tripId: 't1',
      emptyKm: 0,
    });
    expect(r.suggestions[0]?.reasons).toContain('Already at the pickup — no empty running');
  });

  it('rejects a truck whose battery would drop below the reserve before a charger', () => {
    const r = suggestVehicles(
      move,
      [slot({ regNo: 'LOW', freeAt_place: FAR, freeSocPct: 22 })],
      [CFS],
      policy,
      now,
    );
    expect(r.suggestions).toEqual([]);
    expect(r.rejected[0]?.reason).toMatch(
      /^Battery would fall to \d+% before reaching a charger \(reserve 15%\)$/,
    );
  });

  it('rejects a 40ft on a 20ft truck, and trucks with blockers', () => {
    const big = { ...move, uses: { slots: 2 } };
    const r = suggestVehicles(
      big,
      [
        slot({ regNo: 'SMALL', capacity: { slots: 1 } }),
        slot({ regNo: 'EXP', blockers: ['Port pass expired'] }),
      ],
      [CFS],
      policy,
      now,
    );
    expect(r.rejected.map((x) => [x.regNo, x.reason])).toEqual([
      ['SMALL', 'Does not fit (needs 2 slots but vehicle has 1)'],
      ['EXP', 'Port pass expired'],
    ]);
  });

  it('rejects a truck that would miss the cut-off', () => {
    const tight = { ...move, cutoffAt: new Date(now.getTime() + 60 * 60000) };
    const r = suggestVehicles(
      tight,
      [slot({ regNo: 'LATE', freeAt: new Date(now.getTime() + 3 * 3600000) })],
      [CFS],
      policy,
      now,
    );
    expect(r.rejected[0]?.reason).toContain('after the');
  });

  it('a truck returning empty becomes a diversion', () => {
    const r = suggestVehicles(
      move,
      [
        slot({
          regNo: 'RET',
          freeAt_place: { ...CFS, name: 'on the way back' },
          tripId: 't2',
          endsEmpty: true,
        }),
      ],
      [CFS],
      policy,
      now,
    );
    expect(r.suggestions[0]?.kind).toBe('diversion');
  });
});

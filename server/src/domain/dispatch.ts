import { type CapacityVector, checkCapacity } from './capacity';

/**
 * Dispatch engine core (pure). Given the fleet's "next free" forecast and a container to move,
 * filter on hard rules, score the rest, and explain every suggestion in plain words.
 * Weights and thresholds come from tenant policy (lib/settings), never from code.
 */

export interface Point {
  lat: number;
  lng: number;
}

export function straightKm(a: Point, b: Point): number {
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface DispatchPolicy {
  reservePct: number;
  kwhPerKmLoaded: number;
  kwhPerKmEmpty: number;
  avgSpeedKmh: number;
  roadFactor: number;
  weights: {
    emptyKm: number;
    timeToPickup: number;
    batteryAfter: number;
    urgency: number;
    balance: number;
  };
}

export interface MoveToPlace {
  id: string;
  container: string;
  from: Point & { id: string; name: string };
  to: Point & { id: string; name: string };
  uses: CapacityVector;
  cutoffAt: Date | null;
}

/** Where, when and with how much battery a truck becomes free (from live state). */
export interface FleetSlot {
  vehicleId: string;
  regNo: string;
  capacity: CapacityVector;
  batteryKwh: number;
  freeAt: Date;
  freeAt_place: (Point & { id?: string; name: string }) | null;
  freeSocPct: number | null;
  driverId: string | null;
  driverName: string | null;
  /** The open trip this truck is on (suggestion = append a leg) or null (= new trip). */
  tripId: string | null;
  /** True when the truck's last planned leg runs empty (e.g. returning) — a diversion candidate. */
  endsEmpty: boolean;
  legsToday: number;
  blockers: string[]; // expired documents, maintenance, no driver…
}

export interface Suggestion {
  vehicleId: string;
  regNo: string;
  driverId: string | null;
  driverName: string | null;
  action: 'append_leg' | 'new_trip';
  tripId: string | null;
  kind: 'round_trip' | 'diversion' | 'new_trip';
  score: number;
  emptyKm: number;
  pickupAt: Date;
  dropAt: Date;
  socAfterPct: number | null;
  reasons: string[];
}

export interface Rejected {
  vehicleId: string;
  regNo: string;
  reason: string;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const hhmm = (d: Date) =>
  d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  });

export function suggestVehicles(
  move: MoveToPlace,
  fleet: FleetSlot[],
  chargers: Point[],
  policy: DispatchPolicy,
  now: Date,
): { suggestions: Suggestion[]; rejected: Rejected[] } {
  const road = (a: Point, b: Point) => straightKm(a, b) * policy.roadFactor;
  const minutes = (km: number) => (km / policy.avgSpeedKmh) * 60;
  const loadedKm = road(move.from, move.to);
  const toChargerKm = chargers.length ? Math.min(...chargers.map((c) => road(move.to, c))) : 0;
  const suggestions: Suggestion[] = [];
  const rejected: Rejected[] = [];
  const cutoffSoon = move.cutoffAt && move.cutoffAt.getTime() - now.getTime() < 6 * 3600000;

  for (const s of fleet) {
    const reject = (reason: string) =>
      rejected.push({ vehicleId: s.vehicleId, regNo: s.regNo, reason });
    if (s.blockers.length) {
      reject(s.blockers.join('; '));
      continue;
    }
    const cap = checkCapacity(s.capacity, [], [move.uses]);
    if (!cap.ok) {
      reject(`Does not fit (${cap.reason})`);
      continue;
    }
    if (!s.freeAt_place) {
      reject('Location unknown');
      continue;
    }
    const emptyKm = road(s.freeAt_place, move.from);
    const start = new Date(Math.max(s.freeAt.getTime(), now.getTime()));
    const pickupAt = new Date(start.getTime() + minutes(emptyKm) * 60000);
    const dropAt = new Date(pickupAt.getTime() + (minutes(loadedKm) + 60) * 60000); // + ~1 h handling
    if (move.cutoffAt && dropAt > move.cutoffAt) {
      reject(
        `Would reach ${move.to.name} at ${hhmm(dropAt)}, after the ${hhmm(move.cutoffAt)} cut-off`,
      );
      continue;
    }

    let socAfterPct: number | null = null;
    if (s.freeSocPct !== null && s.batteryKwh > 0) {
      const kwh =
        emptyKm * policy.kwhPerKmEmpty +
        loadedKm * policy.kwhPerKmLoaded +
        toChargerKm * policy.kwhPerKmEmpty;
      socAfterPct = s.freeSocPct - (kwh / s.batteryKwh) * 100;
      if (socAfterPct < policy.reservePct) {
        reject(
          `Battery would fall to ${Math.max(0, Math.round(socAfterPct))}% before reaching a charger (reserve ${policy.reservePct}%)`,
        );
        continue;
      }
    }

    // Scoring — each part 0..1, weighted by policy.
    const w = policy.weights;
    const waitMin = (pickupAt.getTime() - now.getTime()) / 60000;
    const parts = {
      emptyKm: 1 - clamp(emptyKm / 40),
      timeToPickup: 1 - clamp(waitMin / 240),
      batteryAfter: socAfterPct === null ? 0.5 : clamp(socAfterPct / 100),
      urgency: cutoffSoon ? 1 - clamp(waitMin / 120) : 0.5,
      balance: 1 - clamp(s.legsToday / 6),
    };
    const total = w.emptyKm + w.timeToPickup + w.batteryAfter + w.urgency + w.balance || 1;
    const score = Math.round(
      ((w.emptyKm * parts.emptyKm +
        w.timeToPickup * parts.timeToPickup +
        w.batteryAfter * parts.batteryAfter +
        w.urgency * parts.urgency +
        w.balance * parts.balance) /
        total) *
        100,
    );

    const sameSpot = emptyKm < 1.5;
    const kind: Suggestion['kind'] =
      s.tripId && !s.endsEmpty && sameSpot
        ? 'round_trip'
        : s.tripId && s.endsEmpty
          ? 'diversion'
          : s.tripId
            ? 'round_trip'
            : 'new_trip';
    const reasons: string[] = [];
    if (s.tripId && s.freeAt > now)
      reasons.push(`Free at ${s.freeAt_place.name} around ${hhmm(s.freeAt)}`);
    else reasons.push(`Free now at ${s.freeAt_place.name}`);
    reasons.push(
      sameSpot
        ? 'Already at the pickup — no empty running'
        : `${Math.round(emptyKm)} km empty to pickup`,
    );
    if (kind === 'round_trip') reasons.push('Turns its trip into a round trip');
    if (kind === 'diversion') reasons.push('Diverts an empty return run into a paid move');
    if (socAfterPct !== null)
      reasons.push(
        `Battery after the job ≈ ${Math.round(socAfterPct)}%${toChargerKm ? ' incl. reaching a charger' : ''}`,
      );
    if (move.cutoffAt) reasons.push(`Drops by ${hhmm(dropAt)} (cut-off ${hhmm(move.cutoffAt)})`);
    if ((cap.free.slots ?? 0) > 0)
      reasons.push(`${cap.free.slots} slot free for another container`);

    suggestions.push({
      vehicleId: s.vehicleId,
      regNo: s.regNo,
      driverId: s.driverId,
      driverName: s.driverName,
      action: s.tripId ? 'append_leg' : 'new_trip',
      tripId: s.tripId,
      kind,
      score,
      emptyKm: Math.round(emptyKm * 10) / 10,
      pickupAt,
      dropAt,
      socAfterPct: socAfterPct === null ? null : Math.round(socAfterPct),
      reasons,
    });
  }

  suggestions.sort((a, b) => b.score - a.score);
  return { suggestions, rejected };
}

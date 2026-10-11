/**
 * Multi-dimensional capacity. A vehicle category has named limits, e.g. { slots: 2, weight_kg: 30000 };
 * each cargo type uses some of them, e.g. 20ft = { slots: 1 }, 40ft = { slots: 2 }.
 * Dimensions the vehicle doesn't limit are ignored.
 */

export type CapacityVector = Record<string, number>;

export interface CapacityCheck {
  ok: boolean;
  used: CapacityVector;
  free: CapacityVector;
  reason?: string;
}

export function checkCapacity(
  capacity: CapacityVector,
  onBoard: CapacityVector[],
  adding: CapacityVector[] = [],
): CapacityCheck {
  const used: CapacityVector = {};
  const free: CapacityVector = {};
  const problems: string[] = [];

  for (const [dim, limit] of Object.entries(capacity)) {
    const total = [...onBoard, ...adding].reduce((sum, c) => sum + (c[dim] ?? 0), 0);
    used[dim] = total;
    free[dim] = limit - total;
    if (total > limit) problems.push(`needs ${total} ${dim} but vehicle has ${limit}`);
  }

  return problems.length
    ? { ok: false, used, free, reason: problems.join('; ') }
    : { ok: true, used, free };
}

import type { Db } from '../db/client';

/**
 * Tenant-level operating policy, stored in tenants.settings and editable by admins.
 * Defaults apply where a value isn't set — nothing here is hardcoded per client.
 */
export interface TenantSettings {
  exceptions: {
    lowBatteryPct: number;
    criticalBatteryPct: number;
    cutoffWarnHours: number;
    noLocationMinutes: number;
    docExpiryDays: number;
  };
  dispatch: {
    /** Battery kept in hand after reaching the nearest charger. */
    reservePct: number;
    /** Energy use per km, used until telematics provides real figures. */
    kwhPerKmLoaded: number;
    kwhPerKmEmpty: number;
    /** Average road speed for ETA until history-based predictions exist. */
    avgSpeedKmh: number;
    /** Road distance ≈ straight-line × factor. */
    roadFactor: number;
    weights: {
      emptyKm: number;
      timeToPickup: number;
      batteryAfter: number;
      urgency: number;
      balance: number;
    };
  };
  /** Autonomy level per decision: suggest (L1) | propose (L2) | auto (L3). */
  autonomy: Record<string, 'suggest' | 'propose' | 'auto'>;
  billing: { approvalRequired: boolean };
}

export const DEFAULT_SETTINGS: TenantSettings = {
  exceptions: {
    lowBatteryPct: 25,
    criticalBatteryPct: 15,
    cutoffWarnHours: 6,
    noLocationMinutes: 20,
    docExpiryDays: 15,
  },
  dispatch: {
    reservePct: 15,
    kwhPerKmLoaded: 1.6,
    kwhPerKmEmpty: 1.1,
    avgSpeedKmh: 25,
    roadFactor: 1.35,
    weights: { emptyKm: 0.35, timeToPickup: 0.2, batteryAfter: 0.15, urgency: 0.2, balance: 0.1 },
  },
  autonomy: {
    assign_vehicle: 'suggest',
    round_trip: 'suggest',
    ai_extraction: 'propose',
    lr_charges: 'propose',
  },
  billing: { approvalRequired: true },
};

type Plain = Record<string, unknown>;
function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out: Plain = { ...(base as Plain) };
  for (const [k, v] of Object.entries(over as Plain)) {
    const b = (base as Plain)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

export async function getSettings(db: Db, tenantId: string): Promise<TenantSettings> {
  const row = await db
    .selectFrom('tenants')
    .select('settings')
    .where('id', '=', tenantId)
    .executeTakeFirst();
  return merge(DEFAULT_SETTINGS, row?.settings);
}

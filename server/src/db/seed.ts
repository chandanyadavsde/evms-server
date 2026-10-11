import { join } from 'node:path';
import { json } from '../lib/db-utils';
import { publishTemplatesFromDir } from '../modules/ai/service';
import { publishRateCardsFromDir } from '../modules/billing/service';
import { publishFlowsFromDir } from '../modules/config/service';
import type { Db } from './client';

/**
 * Demo data for local development and tests. Idempotent: does nothing if the tenant exists.
 * Coordinates are approximate (JNPA / Nhava Sheva area) and only used for geo-checks.
 */
export async function seed(
  db: Db,
  flowsDir: string,
  rateCardsDir = join(flowsDir, '..', 'rate-cards'),
): Promise<{ tenantId: string } | null> {
  const existing = await db
    .selectFrom('tenants')
    .select('id')
    .where('code', '=', 'SKEIRON')
    .executeTakeFirst();
  if (existing) return null;

  return db.transaction().execute(async (tx) => {
    const tenant = await tx
      .insertInto('tenants')
      .values({ code: 'SKEIRON', name: 'Skeiron Logistics', settings: json({}) })
      .returning('id')
      .executeTakeFirstOrThrow();
    const t = tenant.id;

    const region = await tx
      .insertInto('regions')
      .values({
        tenant_id: t,
        code: 'MUM',
        name: 'Mumbai (JNPA)',
        billing_entity: json({ state: 'MH' }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Roles
    const roleIds: Record<string, string> = {};
    for (const [code, name] of [
      ['admin', 'Admin'],
      ['manager', 'Manager'],
      ['driver', 'Driver'],
    ] as const) {
      const r = await tx
        .insertInto('roles')
        .values({ tenant_id: t, code, name, permissions: json([]) })
        .returning('id')
        .executeTakeFirstOrThrow();
      roleIds[code] = r.id;
    }
    const addUser = async (u: {
      name: string;
      email?: string;
      phone?: string;
      role: string;
      language?: string;
    }) => {
      const row = await tx
        .insertInto('users')
        .values({
          tenant_id: t,
          name: u.name,
          email: u.email ?? null,
          phone: u.phone ?? null,
          language: u.language ?? 'en',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('user_roles')
        .values({ user_id: row.id, role_id: roleIds[u.role] as string, region_id: null })
        .execute();
      return row.id;
    };
    await addUser({ name: 'Admin', email: 'admin@sorigin.co', role: 'admin' });
    await addUser({ name: 'Ops Manager', email: 'manager@sorigin.co', role: 'manager' });

    // Clients — LR number series is client config, not code.
    const clients: Record<string, string> = {};
    // Aliases let smart intake match how messages and portals name a client.
    // "ULA" (an NSFT portal group code) is mapped to JM Baxi for the demo only.
    for (const [code, name, lrPrefix, aliases] of [
      ['JMB', 'JM Baxi', 'JMB/', ['JM Baxi & Co', 'JMBaxi', 'ULA']],
      ['NIKE', 'Nike', 'NKE/', ['Nike India']],
    ] as const) {
      const c = await tx
        .insertInto('clients')
        .values({
          tenant_id: t,
          code,
          name,
          billing: json({ lrPrefix }),
          custom: json({}),
          aliases: json(aliases),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      clients[code] = c.id;
    }

    // Place types and places
    const types: Record<string, string> = {};
    for (const [code, name] of [
      ['PORT_TERMINAL', 'Port terminal'],
      ['CFS', 'Container Freight Station'],
      ['EMPTY_YARD', 'Empty yard'],
    ] as const) {
      const lt = await tx
        .insertInto('location_types')
        .values({ tenant_id: t, code, name })
        .returning('id')
        .executeTakeFirstOrThrow();
      types[code] = lt.id;
    }
    const places: [string, string, string, number, number, boolean, string[]][] = [
      [
        'NSICT',
        'NSICT (DP World)',
        'PORT_TERMINAL',
        18.9489,
        72.9425,
        false,
        ['DP World', 'DPW', 'Nhava Sheva International Container Terminal'],
      ],
      [
        'GTI',
        'GTI (APM Terminals)',
        'PORT_TERMINAL',
        18.9547,
        72.9398,
        false,
        ['APM', 'APMT', 'APM Terminals', 'Gateway Terminals India'],
      ],
      [
        'BMCT',
        'BMCT (PSA)',
        'PORT_TERMINAL',
        18.9318,
        72.9472,
        false,
        ['PSA', 'PSA Mumbai', 'Bharat Mumbai Container Terminals'],
      ],
      [
        'CFS-A',
        'CFS Alpha, Uran',
        'CFS',
        18.8902,
        72.9564,
        true,
        ['CFS Alpha', 'Alpha CFS', 'Uran CFS'],
      ],
      [
        'CFS-B',
        'CFS Bravo, Dronagiri',
        'CFS',
        18.8635,
        72.9418,
        true,
        ['CFS Bravo', 'Bravo CFS', 'Dronagiri CFS'],
      ],
      ['EY-1', 'Empty Yard, Jasai', 'EMPTY_YARD', 18.9076, 73.0182, false, ['Jasai', 'Jasai yard']],
      [
        'NSFT',
        'NSFT (Nhava Sheva Freeport Terminal)',
        'PORT_TERMINAL',
        18.9505,
        72.9455, // approximate
        false,
        ['Nhava Sheva Freeport Terminal', 'Freeport Terminal'],
      ],
    ];
    for (const [code, name, type, lat, lng, charging, aliases] of places) {
      await tx
        .insertInto('locations')
        .values({
          tenant_id: t,
          region_id: region.id,
          location_type_id: types[type] as string,
          code,
          name,
          lat,
          lng,
          charging: json(
            charging ? { available: true, chargers: 4, powerKw: 120 } : { available: false },
          ),
          custom: json({}),
          aliases: json(aliases),
          // Demo: the NSFT portal address, so plugin copies from it are tied to this port.
          portal: json(code === 'NSFT' ? { urls: ['portal.nsft.com/eform13'] } : {}),
        })
        .execute();
    }
    // Demo: on the NSFT portal, group code ULA means JM Baxi (a guess — set the real ones in Admin).
    const nsft = await tx
      .selectFrom('locations')
      .select('id')
      .where('tenant_id', '=', t)
      .where('code', '=', 'NSFT')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('port_group_codes')
      .values({ tenant_id: t, port_id: nsft.id, code: 'ULA', client_id: clients.JMB as string })
      .execute();

    // Job types → which workflow they run
    for (const [code, name, from, to, workflowKey] of [
      ['IMPORT_PORT_CFS', 'Import: Port → CFS', 'PORT_TERMINAL', 'CFS', 'import_port_cfs'],
      ['EXPORT_CFS_PORT', 'Export: CFS → Port', 'CFS', 'PORT_TERMINAL', 'export_cfs_port'],
    ] as const) {
      await tx
        .insertInto('job_types')
        .values({
          tenant_id: t,
          code,
          name,
          from_location_type_id: types[from] as string,
          to_location_type_id: types[to] as string,
          workflow_key: workflowKey,
        })
        .execute();
    }

    // Capacity and cargo
    const cat40 = await tx
      .insertInto('vehicle_categories')
      .values({
        tenant_id: t,
        code: 'TRAILER_40',
        name: '40ft EV tractor-trailer',
        capacity: json({ slots: 2 }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const cat20 = await tx
      .insertInto('vehicle_categories')
      .values({
        tenant_id: t,
        code: 'TRAILER_20',
        name: '20ft EV truck',
        capacity: json({ slots: 1 }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [code, name, slots, size] of [
      ['CONTAINER_20', '20ft container', 1, '20ft'],
      ['CONTAINER_40', '40ft container', 2, '40ft'],
    ] as const) {
      await tx
        .insertInto('cargo_types')
        .values({ tenant_id: t, code, name, uses: json({ slots }), attributes: json({ size }) })
        .execute();
    }

    // Fleet and drivers
    const fleet: [string, string, number, number][] = [
      ['MH46 EV 1001', cat40.id, 12450, 82],
      ['MH46 EV 1002', cat40.id, 9870, 64],
      ['MH46 EV 1003', cat40.id, 15210, 91],
      ['MH46 EV 1004', cat20.id, 7320, 47],
      ['MH46 EV 1005', cat20.id, 11005, 73],
    ];
    for (const [reg, cat, odo, soc] of fleet) {
      await tx
        .insertInto('vehicles')
        .values({
          tenant_id: t,
          region_id: region.id,
          category_id: cat,
          reg_no: reg,
          battery_kwh: 282,
          last_odometer_km: odo,
          last_soc_pct: soc,
          custom: json({}),
        })
        .execute();
    }
    const driverList: [string, string, string][] = [
      ['Ramesh Patil', '9000000001', 'hi'],
      ['Suresh Yadav', '9000000002', 'hi'],
      ['Imran Shaikh', '9000000003', 'en'],
      ['Vijay More', '9000000004', 'hi'],
      ['Anil Kumar', '9000000005', 'en'],
    ];
    for (const [name, phone, language] of driverList) {
      const userId = await addUser({ name, phone, role: 'driver', language });
      await tx
        .insertInto('drivers')
        .values({
          tenant_id: t,
          region_id: region.id,
          user_id: userId,
          name,
          phone,
          custom: json({}),
        })
        .execute();
    }

    await publishFlowsFromDir(tx, t, flowsDir);
    await publishRateCardsFromDir(tx, t, rateCardsDir);
    await publishTemplatesFromDir(tx, t, join(flowsDir, '..', 'extraction-templates'));
    return { tenantId: t };
  });
}

/**
 * Loads flows, rate cards and AI templates from config/ into every tenant (idempotent per version).
 * Runs on start in development so config changes appear without wiping data.
 */
export async function syncConfig(db: Db, flowsDir: string): Promise<void> {
  const tenants = await db.selectFrom('tenants').select('id').execute();
  for (const t of tenants) {
    await publishFlowsFromDir(db, t.id, flowsDir);
    await publishRateCardsFromDir(db, t.id, join(flowsDir, '..', 'rate-cards'));
    await publishTemplatesFromDir(db, t.id, join(flowsDir, '..', 'extraction-templates'));
  }
}

import type { FlowDefinition } from '@vms/contracts';
import { sql } from 'kysely';
import type { Db } from '../../db/client';
import { localize } from '../../domain/i18n';
import { json, num, recordEvent } from '../../lib/db-utils';
import { getSettings } from '../../lib/settings';

/**
 * Exception engine: compares the live "mini world" with policy and raises problems with a
 * proposed action. Runs every minute; a problem that goes away is auto-resolved.
 * This is what lets managers work by exception instead of watching every trip.
 */

interface Finding {
  entity: string;
  entityId: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  proposal: Record<string, unknown>;
}

export async function runExceptionChecks(
  db: Db,
  tenantId: string,
  now = new Date(),
): Promise<{ raised: number; resolved: number }> {
  const s = (await getSettings(db, tenantId)).exceptions;
  const findings: Finding[] = [];

  // Active legs with their vehicle, driver and current step.
  const active = await db
    .selectFrom('legs as l')
    .innerJoin('process_instances as p', 'p.id', 'l.process_instance_id')
    .innerJoin('assignments as a', 'a.id', 'l.assignment_id')
    .innerJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .innerJoin('drivers as d', 'd.id', 'a.driver_id')
    .select([
      'l.id as legId',
      'l.trip_id as tripId',
      'p.current_step as step',
      'p.step_entered_at as enteredAt',
      'p.definition_id as definitionId',
      'v.id as vehicleId',
      'v.reg_no as regNo',
      'v.last_soc_pct as soc',
      'v.last_seen_at as lastSeen',
      'd.name as driverName',
      'd.phone as driverPhone',
    ])
    .where('l.tenant_id', '=', tenantId)
    .where('l.status', '=', 'active')
    .execute();

  const flows = new Map<string, FlowDefinition>();
  for (const id of new Set(active.map((a) => a.definitionId))) {
    const row = await db
      .selectFrom('config_definitions')
      .select('body')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    flows.set(id, row.body as FlowDefinition);
  }

  for (const a of active) {
    // 1. Step running past its SLA (configured per step in the flow).
    const step = flows.get(a.definitionId)?.steps.find((x) => x.key === a.step);
    if (step?.sla && a.enteredAt) {
      const minutes = Math.floor((now.getTime() - a.enteredAt.getTime()) / 60000);
      if (minutes > step.sla.maxMinutes) {
        findings.push({
          entity: 'leg',
          entityId: a.legId,
          type: 'sla_breach',
          severity: minutes > step.sla.maxMinutes * 1.5 ? 'critical' : 'warning',
          message: `${a.regNo}: "${localize(step.title, 'en')}" running ${minutes} min (limit ${step.sla.maxMinutes})`,
          proposal: {
            action: 'call_driver',
            label: `Call ${a.driverName}`,
            phone: a.driverPhone,
            tripId: a.tripId,
          },
        });
      }
    }
    // 2. Battery low while on a job.
    const soc = num(a.soc);
    if (soc !== null && soc < s.lowBatteryPct) {
      findings.push({
        entity: 'vehicle',
        entityId: a.vehicleId,
        type: 'low_battery',
        severity: soc < s.criticalBatteryPct ? 'critical' : 'warning',
        message: `${a.regNo} at ${Math.round(soc)}% battery on an active leg`,
        proposal: {
          action: 'plan_charging',
          label: 'Charge at the next CFS stop',
          tripId: a.tripId,
        },
      });
    }
    // 3. Phone stopped reporting location (only once it has reported at least once).
    if (a.lastSeen) {
      const silent = Math.floor((now.getTime() - a.lastSeen.getTime()) / 60000);
      if (silent > s.noLocationMinutes) {
        findings.push({
          entity: 'vehicle',
          entityId: a.vehicleId,
          type: 'no_location',
          severity: 'info',
          message: `${a.regNo}: no location for ${silent} min`,
          proposal: { action: 'call_driver', label: `Call ${a.driverName}`, phone: a.driverPhone },
        });
      }
    }
  }

  // 4. Cut-off approaching for containers that haven't started moving.
  const soon = new Date(now.getTime() + s.cutoffWarnHours * 3600000);
  const atRisk = await db
    .selectFrom('moves as m')
    .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
    .select(['m.id', 'm.status', 'm.cutoff_at as cutoff', 'c.identifier'])
    .where('m.tenant_id', '=', tenantId)
    .where('m.status', 'in', ['pending', 'planned'])
    .where('m.cutoff_at', 'is not', null)
    .where('m.cutoff_at', '<=', soon)
    .execute();
  for (const m of atRisk) {
    if (!m.cutoff) continue;
    const hours = (m.cutoff.getTime() - now.getTime()) / 3600000;
    findings.push({
      entity: 'move',
      entityId: m.id,
      type: 'cutoff_risk',
      severity: hours < 2 ? 'critical' : 'warning',
      message:
        hours <= 0
          ? `${m.identifier}: cut-off passed and it is still ${m.status}`
          : `${m.identifier}: cut-off in ${hours.toFixed(1)} h and still ${m.status}`,
      proposal:
        m.status === 'pending'
          ? { action: 'plan_trip', label: 'Find a truck', moveId: m.id }
          : { action: 'open_board', label: 'Check the trip' },
    });
  }

  // 5. Driver / vehicle documents expiring (dispatch excludes expired ones).
  const horizon = new Date(now.getTime() + s.docExpiryDays * 86400000).toISOString().slice(0, 10);
  const docs = await db
    .selectFrom('entity_documents as e')
    .leftJoin('drivers as d', (j) =>
      j.onRef('d.id', '=', 'e.entity_id').on('e.entity', '=', 'driver'),
    )
    .leftJoin('vehicles as v', (j) =>
      j.onRef('v.id', '=', 'e.entity_id').on('e.entity', '=', 'vehicle'),
    )
    .select(['e.id', 'e.doc_type', 'e.expires_at', 'd.name as driverName', 'v.reg_no as regNo'])
    .where('e.tenant_id', '=', tenantId)
    .where('e.expires_at', 'is not', null)
    .where('e.expires_at', '<=', horizon)
    .execute();
  const today = now.toISOString().slice(0, 10);
  for (const d of docs) {
    const expired = String(d.expires_at).slice(0, 10) < today;
    findings.push({
      entity: 'document',
      entityId: d.id,
      type: 'document_expiring',
      severity: expired ? 'critical' : 'warning',
      message: `${d.driverName ?? d.regNo}: ${d.doc_type.replace(/_/g, ' ')} ${expired ? 'expired' : 'expires'} on ${String(d.expires_at).slice(0, 10)}`,
      proposal: { action: 'renew_document', label: 'Upload renewed document' },
    });
  }

  return reconcile(db, tenantId, findings);
}

/** Problem types this engine raises and may auto-resolve. Others (e.g. AI mismatches) are closed by people. */
const ENGINE_TYPES = [
  'sla_breach',
  'low_battery',
  'no_location',
  'cutoff_risk',
  'document_expiring',
];

/** Insert new findings, refresh existing ones, auto-resolve those that no longer apply. */
async function reconcile(db: Db, tenantId: string, findings: Finding[]) {
  const open = await db
    .selectFrom('exceptions')
    .select(['id', 'entity', 'entity_id', 'type'])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'open')
    .where('type', 'in', ENGINE_TYPES)
    .execute();
  const key = (e: { entity: string; entity_id?: string; entityId?: string; type: string }) =>
    `${e.entity}|${e.entity_id ?? e.entityId}|${e.type}`;
  const openByKey = new Map(open.map((o) => [key(o), o.id]));
  const seen = new Set<string>();
  let raised = 0;

  for (const f of findings) {
    const k = key(f);
    if (seen.has(k)) continue;
    seen.add(k);
    const existing = openByKey.get(k);
    if (existing) {
      await db
        .updateTable('exceptions')
        .set({ severity: f.severity, message: f.message, proposal: json(f.proposal) })
        .where('id', '=', existing)
        .execute();
      continue;
    }
    // A dismissed problem stays quiet until it changes type or is resolved for real.
    const dismissed = await db
      .selectFrom('exceptions')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('entity_id', '=', f.entityId)
      .where('type', '=', f.type)
      .where('status', '=', 'dismissed')
      .where('resolved_at', '>', sql<Date>`now() - interval '12 hours'`)
      .executeTakeFirst();
    if (dismissed) continue;
    const row = await db
      .insertInto('exceptions')
      .values({
        tenant_id: tenantId,
        entity: f.entity,
        entity_id: f.entityId,
        type: f.type,
        severity: f.severity,
        message: f.message,
        proposal: json(f.proposal),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordEvent(db, {
      tenantId,
      entity: f.entity,
      entityId: f.entityId,
      type: `exception.${f.type}`,
      payload: { exceptionId: row.id, message: f.message },
    });
    raised++;
  }

  const stale = open.filter((o) => !seen.has(key(o))).map((o) => o.id);
  if (stale.length) {
    await db
      .updateTable('exceptions')
      .set({
        status: 'resolved',
        resolved_at: new Date(),
        resolution: 'Resolved automatically — condition cleared',
      })
      .where('id', 'in', stale)
      .execute();
  }
  return { raised, resolved: stale.length };
}

export async function runForAllTenants(db: Db) {
  const tenants = await db.selectFrom('tenants').select('id').execute();
  for (const t of tenants) await runExceptionChecks(db, t.id);
}

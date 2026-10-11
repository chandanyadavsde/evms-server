import { type Kysely, sql } from 'kysely';

/**
 * Tables for exceptions, live state, documents, AI, billing integration and dispatch learning.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const id = sql`uuid PRIMARY KEY DEFAULT gen_random_uuid()`;
  const now = sql`timestamptz NOT NULL DEFAULT now()`;

  // When the current step was entered — drives SLA checks.
  await sql`ALTER TABLE process_instances ADD COLUMN step_entered_at timestamptz`.execute(db);
  await sql`UPDATE process_instances SET step_entered_at = coalesce(started_at, created_at)`.execute(
    db,
  );

  // LR approval / push trail.
  await sql`ALTER TABLE lrs
    ADD COLUMN approved_by uuid REFERENCES users(id),
    ADD COLUMN approved_at timestamptz,
    ADD COLUMN pushed_at timestamptz,
    ADD COLUMN rate_card_id uuid REFERENCES config_definitions(id)`.execute(db);

  /** Problems the system detected, with a proposed action — the manager's exception queue. */
  await sql`CREATE TABLE exceptions (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    entity text NOT NULL,
    entity_id uuid NOT NULL,
    type text NOT NULL,              -- sla_breach, low_battery, cutoff_risk, no_location, document_expiring ...
    severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
    message text NOT NULL,
    proposal jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    created_at ${now},
    resolved_at timestamptz,
    resolved_by uuid REFERENCES users(id),
    resolution text
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX exceptions_open_uq ON exceptions (tenant_id, entity, entity_id, type)
    WHERE status = 'open'`.execute(db);

  /** GPS pings from the driver app (telematics later). Partition by month when volume grows. */
  await sql`CREATE TABLE vehicle_positions (
    id bigserial PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    vehicle_id uuid NOT NULL REFERENCES vehicles(id),
    driver_id uuid REFERENCES drivers(id),
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    speed_kmh double precision,
    recorded_at timestamptz NOT NULL,
    created_at ${now}
  )`.execute(db);
  await sql`CREATE INDEX vehicle_positions_latest_idx ON vehicle_positions (vehicle_id, recorded_at DESC)`.execute(
    db,
  );
  await sql`ALTER TABLE vehicles
    ADD COLUMN last_lat double precision,
    ADD COLUMN last_lng double precision,
    ADD COLUMN last_seen_at timestamptz`.execute(db);

  /** Licences, port passes, permits, insurance — with expiry, used by dispatch filters. */
  await sql`CREATE TABLE entity_documents (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    entity text NOT NULL CHECK (entity IN ('driver','vehicle')),
    entity_id uuid NOT NULL,
    doc_type text NOT NULL,          -- licence, port_pass, permit, fitness, insurance, puc
    number text,
    expires_at date,
    file_key text,
    created_at ${now}
  )`.execute(db);
  await sql`CREATE INDEX entity_documents_idx ON entity_documents (entity, entity_id)`.execute(db);

  /** Driver duty periods with start/end readings (handover evidence). */
  await sql`CREATE TABLE driver_shifts (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    driver_id uuid NOT NULL REFERENCES drivers(id),
    vehicle_id uuid REFERENCES vehicles(id),
    started_at ${now},
    ended_at timestamptz,
    start_readings jsonb NOT NULL DEFAULT '{}',
    end_readings jsonb NOT NULL DEFAULT '{}'
  )`.execute(db);

  /** AI reads: portal screenshots, documents, dashboard photos. Every result is reviewed. */
  await sql`CREATE TABLE ai_extractions (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    kind text NOT NULL CHECK (kind IN ('portal_screenshot','document','reading')),
    template_key text,
    file_key text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','confirmed','rejected')),
    result jsonb,
    corrected jsonb,
    model text,
    error text,
    created_by uuid REFERENCES users(id),
    created_at ${now},
    confirmed_by uuid REFERENCES users(id),
    confirmed_at timestamptz
  )`.execute(db);

  /** Outbound integration queue (NetSuite first). Idempotent by (target, entity, entity_id). */
  await sql`CREATE TABLE integration_outbox (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    target text NOT NULL,
    entity text NOT NULL,
    entity_id uuid NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    external_ref text,
    created_at ${now},
    sent_at timestamptz,
    UNIQUE (target, entity, entity_id)
  )`.execute(db);

  /** What the dispatch engine suggested vs what the manager chose (shadow mode / learning). */
  await sql`CREATE TABLE dispatch_suggestions (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    move_id uuid NOT NULL REFERENCES moves(id),
    ranked jsonb NOT NULL,           -- [{vehicleId, driverId, score, reasons}]
    chosen_vehicle_id uuid REFERENCES vehicles(id),
    chosen_rank integer,             -- 1 = top suggestion taken; null = not in list
    created_at ${now},
    decided_at timestamptz
  )`.execute(db);
  await sql`CREATE INDEX dispatch_suggestions_move_idx ON dispatch_suggestions (move_id, created_at DESC)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'dispatch_suggestions',
    'integration_outbox',
    'ai_extractions',
    'driver_shifts',
    'entity_documents',
    'vehicle_positions',
    'exceptions',
  ]) {
    await sql`DROP TABLE IF EXISTS ${sql.table(t)} CASCADE`.execute(db);
  }
  await sql`ALTER TABLE vehicles DROP COLUMN last_lat, DROP COLUMN last_lng, DROP COLUMN last_seen_at`.execute(
    db,
  );
  await sql`ALTER TABLE lrs DROP COLUMN approved_by, DROP COLUMN approved_at, DROP COLUMN pushed_at, DROP COLUMN rate_card_id`.execute(
    db,
  );
  await sql`ALTER TABLE process_instances DROP COLUMN step_entered_at`.execute(db);
}

import { type Kysely, sql } from 'kysely';

/**
 * Core schema. Fixed tables for the engine; client-specific data goes in `custom` JSONB.
 * Every business table carries tenant_id so the platform can serve other companies later.
 * Geo is stored as lat/lng for the MVP (no PostGIS needed); PostGIS can be added later.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const id = sql`uuid PRIMARY KEY DEFAULT gen_random_uuid()`;
  const now = sql`timestamptz NOT NULL DEFAULT now()`;

  // --- Organisation -------------------------------------------------------
  await sql`CREATE TABLE tenants (
    id ${id},
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    settings jsonb NOT NULL DEFAULT '{}',
    created_at ${now}
  )`.execute(db);

  await sql`CREATE TABLE regions (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL,
    name text NOT NULL,
    timezone text NOT NULL DEFAULT 'Asia/Kolkata',
    billing_entity jsonb NOT NULL DEFAULT '{}',
    created_at ${now},
    UNIQUE (tenant_id, code)
  )`.execute(db);

  await sql`CREATE TABLE clients (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL,
    name text NOT NULL,
    gstin text,
    billing jsonb NOT NULL DEFAULT '{}',
    custom jsonb NOT NULL DEFAULT '{}',
    active boolean NOT NULL DEFAULT true,
    created_at ${now},
    UNIQUE (tenant_id, code)
  )`.execute(db);

  // --- Users, roles, login --------------------------------------------------
  await sql`CREATE TABLE users (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    name text NOT NULL,
    email text,
    phone text,
    language text NOT NULL DEFAULT 'en',
    active boolean NOT NULL DEFAULT true,
    created_at ${now},
    UNIQUE (tenant_id, email),
    UNIQUE (tenant_id, phone),
    CHECK (email IS NOT NULL OR phone IS NOT NULL)
  )`.execute(db);

  await sql`CREATE TABLE roles (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL,              -- admin, manager, driver
    name text NOT NULL,
    permissions jsonb NOT NULL DEFAULT '[]',
    UNIQUE (tenant_id, code)
  )`.execute(db);

  await sql`CREATE TABLE user_roles (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    region_id uuid REFERENCES regions(id),     -- null = all regions
    PRIMARY KEY (user_id, role_id)
  )`.execute(db);

  await sql`CREATE TABLE otp_codes (
    id ${id},
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    consumed_at timestamptz,
    created_at ${now}
  )`.execute(db);

  // --- Configurable types --------------------------------------------------
  await sql`CREATE TABLE location_types (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL,              -- CFS, PORT_TERMINAL, EMPTY_YARD, DEPOT
    name text NOT NULL,
    UNIQUE (tenant_id, code)
  )`.execute(db);

  /** Capacity is a set of named dimensions, e.g. {"slots": 2, "weight_kg": 30000}. */
  await sql`CREATE TABLE vehicle_categories (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL,              -- TRAILER_20, TRAILER_40
    name text NOT NULL,
    capacity jsonb NOT NULL,
    UNIQUE (tenant_id, code)
  )`.execute(db);

  await sql`CREATE TABLE cargo_types (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL,              -- CONTAINER_20, CONTAINER_40
    name text NOT NULL,
    uses jsonb NOT NULL,             -- capacity used, e.g. {"slots": 1}
    attributes jsonb NOT NULL DEFAULT '{}',  -- exposed to flow rules, e.g. {"size": "20ft"}
    UNIQUE (tenant_id, code)
  )`.execute(db);

  /** Versioned configuration: workflows, rate cards, extraction templates, LR templates. */
  await sql`CREATE TABLE config_definitions (
    id ${id},
    tenant_id uuid REFERENCES tenants(id),   -- null = platform default
    region_id uuid REFERENCES regions(id),
    client_id uuid REFERENCES clients(id),
    kind text NOT NULL CHECK (kind IN ('workflow','rate_card','extraction_template','lr_template','document_type')),
    key text NOT NULL,
    version integer NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
    body jsonb NOT NULL,
    created_by uuid REFERENCES users(id),
    created_at ${now},
    published_at timestamptz
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX config_definitions_version_uq ON config_definitions
    (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
     coalesce(region_id, '00000000-0000-0000-0000-000000000000'::uuid),
     coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid),
     kind, key, version)`.execute(db);

  await sql`CREATE TABLE job_types (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL,              -- IMPORT_PORT_CFS, EXPORT_CFS_PORT
    name text NOT NULL,
    from_location_type_id uuid NOT NULL REFERENCES location_types(id),
    to_location_type_id uuid NOT NULL REFERENCES location_types(id),
    workflow_key text NOT NULL,      -- resolved via config_definitions
    UNIQUE (tenant_id, code)
  )`.execute(db);

  // --- Master data ---------------------------------------------------------
  await sql`CREATE TABLE locations (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    region_id uuid NOT NULL REFERENCES regions(id),
    location_type_id uuid NOT NULL REFERENCES location_types(id),
    code text NOT NULL,
    name text NOT NULL,
    address text,
    lat double precision,
    lng double precision,
    geofence_radius_m integer NOT NULL DEFAULT 300,
    charging jsonb NOT NULL DEFAULT '{"available": false}',
    custom jsonb NOT NULL DEFAULT '{}',
    UNIQUE (tenant_id, code)
  )`.execute(db);

  await sql`CREATE TABLE vehicles (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    region_id uuid NOT NULL REFERENCES regions(id),
    category_id uuid NOT NULL REFERENCES vehicle_categories(id),
    reg_no text NOT NULL,
    battery_kwh numeric(6,1),
    last_odometer_km numeric(10,1),
    last_soc_pct numeric(5,2),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','inactive')),
    custom jsonb NOT NULL DEFAULT '{}',
    UNIQUE (tenant_id, reg_no)
  )`.execute(db);

  await sql`CREATE TABLE drivers (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    region_id uuid NOT NULL REFERENCES regions(id),
    user_id uuid REFERENCES users(id),
    name text NOT NULL,
    phone text NOT NULL,
    licence_no text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    custom jsonb NOT NULL DEFAULT '{}',
    UNIQUE (tenant_id, phone)
  )`.execute(db);

  // --- Process engine ------------------------------------------------------
  /** A running workflow, attachable to any entity (leg today; LR, vehicle, driver later). */
  await sql`CREATE TABLE process_instances (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    entity text NOT NULL,
    entity_id uuid NOT NULL,
    definition_id uuid NOT NULL REFERENCES config_definitions(id),  -- pinned version
    current_step text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','cancelled')),
    captured jsonb NOT NULL DEFAULT '{}',   -- values by step key
    started_at timestamptz,
    ended_at timestamptz,
    created_at ${now}
  )`.execute(db);
  await sql`CREATE INDEX process_instances_entity_idx ON process_instances (entity, entity_id)`.execute(
    db,
  );

  // --- Operations ----------------------------------------------------------
  await sql`CREATE TABLE cargo (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    cargo_type_id uuid NOT NULL REFERENCES cargo_types(id),
    identifier text NOT NULL,        -- container number
    state text NOT NULL DEFAULT 'loaded' CHECK (state IN ('loaded','empty')),
    custom jsonb NOT NULL DEFAULT '{}',
    created_at ${now}
  )`.execute(db);
  await sql`CREATE INDEX cargo_identifier_idx ON cargo (tenant_id, identifier)`.execute(db);

  await sql`CREATE TABLE moves (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    region_id uuid NOT NULL REFERENCES regions(id),
    client_id uuid NOT NULL REFERENCES clients(id),
    job_type_id uuid NOT NULL REFERENCES job_types(id),
    cargo_id uuid NOT NULL REFERENCES cargo(id),
    from_location_id uuid NOT NULL REFERENCES locations(id),
    to_location_id uuid NOT NULL REFERENCES locations(id),
    ready_at timestamptz,
    cutoff_at timestamptz,
    priority integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','planned','in_progress','completed','cancelled')),
    custom jsonb NOT NULL DEFAULT '{}',
    created_by uuid REFERENCES users(id),
    created_at ${now}
  )`.execute(db);
  await sql`CREATE INDEX moves_status_idx ON moves (tenant_id, region_id, status)`.execute(db);

  /** Vehicle + driver for a period. A driver change mid-trip = a new assignment on later legs. */
  await sql`CREATE TABLE assignments (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    vehicle_id uuid NOT NULL REFERENCES vehicles(id),
    driver_id uuid NOT NULL REFERENCES drivers(id),
    starts_at timestamptz NOT NULL DEFAULT now(),
    ends_at timestamptz,
    start_readings jsonb NOT NULL DEFAULT '{}',
    end_readings jsonb NOT NULL DEFAULT '{}'
  )`.execute(db);

  await sql`CREATE TABLE trips (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    region_id uuid NOT NULL REFERENCES regions(id),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
    started_at timestamptz,
    ended_at timestamptz,
    created_by uuid REFERENCES users(id),
    created_at ${now}
  )`.execute(db);

  await sql`CREATE TABLE legs (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    trip_id uuid NOT NULL REFERENCES trips(id),
    seq integer NOT NULL,
    assignment_id uuid NOT NULL REFERENCES assignments(id),
    from_location_id uuid NOT NULL REFERENCES locations(id),
    to_location_id uuid NOT NULL REFERENCES locations(id),
    kind text NOT NULL CHECK (kind IN ('loaded','empty')),
    process_instance_id uuid REFERENCES process_instances(id),
    status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','cancelled')),
    started_at timestamptz,
    ended_at timestamptz,
    UNIQUE (trip_id, seq)
  )`.execute(db);

  await sql`CREATE TABLE leg_moves (
    leg_id uuid NOT NULL REFERENCES legs(id) ON DELETE CASCADE,
    move_id uuid NOT NULL REFERENCES moves(id),
    PRIMARY KEY (leg_id, move_id)
  )`.execute(db);

  // --- LR ------------------------------------------------------------------
  /** One LR = one client + one vehicle + one leg (1x20, 2x20 or 1x40). */
  await sql`CREATE TABLE lrs (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    region_id uuid NOT NULL REFERENCES regions(id),
    client_id uuid NOT NULL REFERENCES clients(id),
    leg_id uuid NOT NULL REFERENCES legs(id),
    number text,                     -- assigned when issued
    status text NOT NULL DEFAULT 'pre_lr'
      CHECK (status IN ('pre_lr','issued','closed','billable','pushed','cancelled')),
    charges jsonb NOT NULL DEFAULT '[]',
    total_amount numeric(12,2),
    netsuite_ref text,
    custom jsonb NOT NULL DEFAULT '{}',
    created_at ${now},
    issued_at timestamptz,
    closed_at timestamptz,
    UNIQUE (tenant_id, number)
  )`.execute(db);

  await sql`CREATE TABLE lr_moves (
    lr_id uuid NOT NULL REFERENCES lrs(id) ON DELETE CASCADE,
    move_id uuid NOT NULL UNIQUE REFERENCES moves(id),   -- a move is on exactly one LR
    PRIMARY KEY (lr_id, move_id)
  )`.execute(db);

  await sql`CREATE TABLE lr_sequences (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    prefix text NOT NULL,
    next_value integer NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, prefix)
  )`.execute(db);

  // --- Evidence & audit -----------------------------------------------------
  await sql`CREATE TABLE evidence (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    process_instance_id uuid REFERENCES process_instances(id),
    step_key text,
    field_key text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('photo','document','signature','reading','text')),
    doc_type text,
    file_key text,                   -- object key in local storage / S3
    value jsonb,
    ai_result jsonb,
    captured_by uuid REFERENCES users(id),
    captured_at timestamptz NOT NULL DEFAULT now(),
    lat double precision,
    lng double precision,
    verified_by uuid REFERENCES users(id),
    verified_at timestamptz
  )`.execute(db);
  await sql`CREATE INDEX evidence_process_idx ON evidence (process_instance_id)`.execute(db);

  /** Append-only event log: audit trail + feed for analytics and dispatch learning. */
  await sql`CREATE TABLE events (
    id bigserial PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    entity text NOT NULL,
    entity_id uuid NOT NULL,
    type text NOT NULL,
    actor_id uuid REFERENCES users(id),
    payload jsonb NOT NULL DEFAULT '{}',
    created_at ${now}
  )`.execute(db);
  await sql`CREATE INDEX events_entity_idx ON events (entity, entity_id, created_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'events',
    'evidence',
    'lr_sequences',
    'lr_moves',
    'lrs',
    'leg_moves',
    'legs',
    'trips',
    'assignments',
    'moves',
    'cargo',
    'process_instances',
    'drivers',
    'vehicles',
    'locations',
    'job_types',
    'config_definitions',
    'cargo_types',
    'vehicle_categories',
    'location_types',
    'otp_codes',
    'user_roles',
    'roles',
    'users',
    'clients',
    'regions',
    'tenants',
  ]) {
    await sql`DROP TABLE IF EXISTS ${sql.table(t)} CASCADE`.execute(db);
  }
}

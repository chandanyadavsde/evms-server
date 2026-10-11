import type { ColumnType, Generated } from 'kysely';

/** Kysely table types. Keep in sync with migrations (switch to kysely-codegen later). */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
/** JSONB: read as parsed value, written as a JSON string (see `json()` in lib/db-utils). */
type Json<T = Record<string, unknown>> = ColumnType<T, string | undefined, string>;
/** numeric columns come back as strings from Postgres. */
type Numeric = ColumnType<
  string | null,
  number | string | null | undefined,
  number | string | null
>;

export interface TenantsTable {
  id: Generated<string>;
  code: string;
  name: string;
  settings: Json;
  created_at: Timestamp;
}

export interface RegionsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  timezone: Generated<string>;
  billing_entity: Json;
  created_at: Timestamp;
}

export interface ClientsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  gstin: string | null;
  billing: Json<{ lrPrefix?: string } & Record<string, unknown>>;
  custom: Json;
  /** Other names that mean this client: portal group codes, short names. */
  aliases: Json<string[]>;
  active: Generated<boolean>;
  created_at: Timestamp;
}

export interface UsersTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  language: Generated<string>;
  active: Generated<boolean>;
  created_at: Timestamp;
}

export interface RolesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  permissions: Json<string[]>;
}

export interface UserRolesTable {
  user_id: string;
  role_id: string;
  region_id: string | null;
}

export interface OtpCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  expires_at: Timestamp;
  attempts: Generated<number>;
  consumed_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface LocationTypesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
}

export interface VehicleCategoriesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  capacity: Json<Record<string, number>>;
}

export interface CargoTypesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  uses: Json<Record<string, number>>;
  attributes: Json;
}

export interface ConfigDefinitionsTable {
  id: Generated<string>;
  tenant_id: string | null;
  region_id: string | null;
  client_id: string | null;
  kind: 'workflow' | 'rate_card' | 'extraction_template' | 'lr_template' | 'document_type';
  key: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  body: Json<unknown>;
  created_by: string | null;
  created_at: Timestamp;
  published_at: NullableTimestamp;
}

export interface JobTypesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  from_location_type_id: string;
  to_location_type_id: string;
  workflow_key: string;
  /** Switched off trip types are hidden when planning (only CFS → Port is in use at first). */
  active: Generated<boolean>;
}

export interface LocationsTable {
  id: Generated<string>;
  tenant_id: string;
  region_id: string;
  location_type_id: string;
  code: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  geofence_radius_m: Generated<number>;
  charging: Json;
  custom: Json;
  /** Other names that mean this place: "Nhava Sheva", "DPW", a portal's own code. */
  aliases: Json<string[]>;
  /** Ports: the web address(es) of their portal, e.g. {urls: ["portal.nsft.com/eform13"]}. */
  portal: Json<{ urls?: string[] }>;
}

export interface VehiclesTable {
  id: Generated<string>;
  tenant_id: string;
  region_id: string;
  category_id: string;
  reg_no: string;
  battery_kwh: Numeric;
  last_odometer_km: Numeric;
  last_soc_pct: Numeric;
  status: Generated<'active' | 'maintenance' | 'inactive'>;
  custom: Json;
  last_lat: number | null;
  last_lng: number | null;
  last_seen_at: NullableTimestamp;
}

export interface DriversTable {
  id: Generated<string>;
  tenant_id: string;
  region_id: string;
  user_id: string | null;
  name: string;
  phone: string;
  licence_no: string | null;
  status: Generated<'active' | 'inactive'>;
  custom: Json;
}

export interface ProcessInstancesTable {
  id: Generated<string>;
  tenant_id: string;
  entity: string;
  entity_id: string;
  definition_id: string;
  current_step: string | null;
  status: Generated<'pending' | 'active' | 'completed' | 'cancelled'>;
  captured: Json<Record<string, Record<string, unknown>>>;
  started_at: NullableTimestamp;
  ended_at: NullableTimestamp;
  step_entered_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface CargoTable {
  id: Generated<string>;
  tenant_id: string;
  cargo_type_id: string;
  /** Container number; null until known (a portal pendency gives counts, not numbers). */
  identifier: string | null;
  state: Generated<'loaded' | 'empty'>;
  custom: Json;
  created_at: Timestamp;
}

export type MoveStatus = 'pending' | 'planned' | 'in_progress' | 'completed' | 'cancelled';

export interface MovesTable {
  id: Generated<string>;
  tenant_id: string;
  region_id: string;
  client_id: string;
  job_type_id: string;
  cargo_id: string;
  from_location_id: string;
  to_location_id: string;
  ready_at: NullableTimestamp;
  cutoff_at: NullableTimestamp;
  priority: Generated<number>;
  status: Generated<MoveStatus>;
  custom: Json;
  created_by: string | null;
  created_at: Timestamp;
}

export interface AssignmentsTable {
  id: Generated<string>;
  tenant_id: string;
  vehicle_id: string;
  driver_id: string;
  starts_at: Timestamp;
  ends_at: NullableTimestamp;
  start_readings: Json;
  end_readings: Json;
}

export interface TripsTable {
  id: Generated<string>;
  tenant_id: string;
  region_id: string;
  status: Generated<'active' | 'completed' | 'cancelled'>;
  started_at: NullableTimestamp;
  ended_at: NullableTimestamp;
  created_by: string | null;
  created_at: Timestamp;
}

export type LegStatus = 'planned' | 'active' | 'completed' | 'cancelled';

export interface LegsTable {
  id: Generated<string>;
  tenant_id: string;
  trip_id: string;
  seq: number;
  assignment_id: string;
  from_location_id: string;
  to_location_id: string;
  kind: 'loaded' | 'empty';
  process_instance_id: string | null;
  status: Generated<LegStatus>;
  started_at: NullableTimestamp;
  ended_at: NullableTimestamp;
}

export interface LegMovesTable {
  leg_id: string;
  move_id: string;
}

export type LrStatus = 'pre_lr' | 'issued' | 'closed' | 'billable' | 'pushed' | 'cancelled';

export interface LrsTable {
  id: Generated<string>;
  tenant_id: string;
  region_id: string;
  client_id: string;
  leg_id: string;
  number: string | null;
  status: Generated<LrStatus>;
  charges: Json<unknown[]>;
  total_amount: Numeric;
  netsuite_ref: string | null;
  custom: Json;
  created_at: Timestamp;
  issued_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  approved_by: string | null;
  approved_at: NullableTimestamp;
  pushed_at: NullableTimestamp;
  rate_card_id: string | null;
}

export interface LrMovesTable {
  lr_id: string;
  move_id: string;
}

export interface LrSequencesTable {
  tenant_id: string;
  prefix: string;
  next_value: Generated<number>;
}

export interface EvidenceTable {
  id: Generated<string>;
  tenant_id: string;
  process_instance_id: string | null;
  step_key: string | null;
  field_key: string;
  kind: 'photo' | 'document' | 'signature' | 'reading' | 'text';
  doc_type: string | null;
  file_key: string | null;
  value: Json<unknown> | null;
  ai_result: Json<unknown> | null;
  captured_by: string | null;
  captured_at: Timestamp;
  lat: number | null;
  lng: number | null;
  verified_by: string | null;
  verified_at: NullableTimestamp;
}

export interface EventsTable {
  id: Generated<string>;
  tenant_id: string;
  entity: string;
  entity_id: string;
  type: string;
  actor_id: string | null;
  payload: Json<unknown>;
  created_at: Timestamp;
}

export interface ExceptionsTable {
  id: Generated<string>;
  tenant_id: string;
  entity: string;
  entity_id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  proposal: Json;
  status: Generated<'open' | 'resolved' | 'dismissed'>;
  created_at: Timestamp;
  resolved_at: NullableTimestamp;
  resolved_by: string | null;
  resolution: string | null;
}

export interface VehiclePositionsTable {
  id: Generated<string>;
  tenant_id: string;
  vehicle_id: string;
  driver_id: string | null;
  lat: number;
  lng: number;
  speed_kmh: number | null;
  recorded_at: Timestamp;
  created_at: Timestamp;
}

export interface EntityDocumentsTable {
  id: Generated<string>;
  tenant_id: string;
  entity: 'driver' | 'vehicle';
  entity_id: string;
  doc_type: string;
  number: string | null;
  expires_at: ColumnType<string | null, string | null | undefined, string | null>;
  file_key: string | null;
  created_at: Timestamp;
}

export interface DriverShiftsTable {
  id: Generated<string>;
  tenant_id: string;
  driver_id: string;
  vehicle_id: string | null;
  started_at: Timestamp;
  ended_at: NullableTimestamp;
  start_readings: Json;
  end_readings: Json;
}

export interface AiExtractionsTable {
  id: Generated<string>;
  tenant_id: string;
  kind: 'portal_screenshot' | 'document' | 'reading';
  template_key: string | null;
  file_key: string;
  status: Generated<'pending' | 'done' | 'failed' | 'confirmed' | 'rejected'>;
  result: Json<unknown> | null;
  corrected: Json<unknown> | null;
  model: string | null;
  error: string | null;
  created_by: string | null;
  created_at: Timestamp;
  confirmed_by: string | null;
  confirmed_at: NullableTimestamp;
}

export interface IntegrationOutboxTable {
  id: Generated<string>;
  tenant_id: string;
  target: string;
  entity: string;
  entity_id: string;
  payload: Json<unknown>;
  status: Generated<'pending' | 'sent' | 'failed'>;
  attempts: Generated<number>;
  last_error: string | null;
  external_ref: string | null;
  created_at: Timestamp;
  sent_at: NullableTimestamp;
}

export interface DispatchSuggestionsTable {
  id: Generated<string>;
  tenant_id: string;
  move_id: string;
  ranked: Json<unknown[]>;
  chosen_vehicle_id: string | null;
  chosen_rank: number | null;
  created_at: Timestamp;
  decided_at: NullableTimestamp;
}

export interface IntakeRequestsTable {
  id: Generated<string>;
  tenant_id: string;
  source_text: string | null;
  file_keys: Json<string[]>;
  status: Generated<'read' | 'failed' | 'confirmed' | 'discarded'>;
  provider: string | null;
  model: string | null;
  raw: Json<unknown> | null;
  draft: Json<unknown> | null;
  error: string | null;
  move_ids: Json<string[]>;
  /** {kind: "web"} or {kind: "plugin", url, title} — where the input was copied from. */
  source: Json<{ kind: string; url?: string; title?: string }>;
  created_by: string | null;
  created_at: Timestamp;
  confirmed_by: string | null;
  confirmed_at: NullableTimestamp;
}

export interface AssistMappingsTable {
  id: Generated<string>;
  tenant_id: string;
  page_key: string;
  fields: Json<Record<string, { dataKey: string; label: string }>>;
  uses: Generated<number>;
  updated_by: string | null;
  updated_at: Timestamp;
}

export interface PortGroupCodesTable {
  id: Generated<string>;
  tenant_id: string;
  port_id: string;
  code: string;
  client_id: string;
  created_at: Timestamp;
}

export interface UserScopesTable {
  tenant_id: string;
  user_id: string;
  location_id: string;
}

export interface Database {
  port_group_codes: PortGroupCodesTable;
  user_scopes: UserScopesTable;
  assist_mappings: AssistMappingsTable;
  intake_requests: IntakeRequestsTable;
  exceptions: ExceptionsTable;
  vehicle_positions: VehiclePositionsTable;
  entity_documents: EntityDocumentsTable;
  driver_shifts: DriverShiftsTable;
  ai_extractions: AiExtractionsTable;
  integration_outbox: IntegrationOutboxTable;
  dispatch_suggestions: DispatchSuggestionsTable;
  tenants: TenantsTable;
  regions: RegionsTable;
  clients: ClientsTable;
  users: UsersTable;
  roles: RolesTable;
  user_roles: UserRolesTable;
  otp_codes: OtpCodesTable;
  location_types: LocationTypesTable;
  vehicle_categories: VehicleCategoriesTable;
  cargo_types: CargoTypesTable;
  config_definitions: ConfigDefinitionsTable;
  job_types: JobTypesTable;
  locations: LocationsTable;
  vehicles: VehiclesTable;
  drivers: DriversTable;
  process_instances: ProcessInstancesTable;
  cargo: CargoTable;
  moves: MovesTable;
  assignments: AssignmentsTable;
  trips: TripsTable;
  legs: LegsTable;
  leg_moves: LegMovesTable;
  lrs: LrsTable;
  lr_moves: LrMovesTable;
  lr_sequences: LrSequencesTable;
  evidence: EvidenceTable;
  events: EventsTable;
}

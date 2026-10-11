import { type Kysely, sql } from 'kysely';

/**
 * Phase 1 — masters and access:
 * - a port knows its portal web address(es), so a copy from that page is tied to that port;
 * - group codes ("ULA") belong to a port: the same code can mean another client elsewhere;
 * - trip types can be switched on/off (only CFS → Port is in use at first);
 * - an admin assigns ports and CFSs to each supervisor; a supervisor with none assigned sees all.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const id = sql`uuid PRIMARY KEY DEFAULT gen_random_uuid()`;

  await sql`ALTER TABLE locations ADD COLUMN portal jsonb NOT NULL DEFAULT '{}'`.execute(db);
  await sql`ALTER TABLE job_types ADD COLUMN active boolean NOT NULL DEFAULT true`.execute(db);

  await sql`CREATE TABLE port_group_codes (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    port_id uuid NOT NULL REFERENCES locations(id),
    code text NOT NULL,
    client_id uuid NOT NULL REFERENCES clients(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, port_id, code)
  )`.execute(db);

  await sql`CREATE TABLE user_scopes (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    user_id uuid NOT NULL REFERENCES users(id),
    location_id uuid NOT NULL REFERENCES locations(id),
    PRIMARY KEY (user_id, location_id)
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS user_scopes`.execute(db);
  await sql`DROP TABLE IF EXISTS port_group_codes`.execute(db);
  await sql`ALTER TABLE job_types DROP COLUMN active`.execute(db);
  await sql`ALTER TABLE locations DROP COLUMN portal`.execute(db);
}

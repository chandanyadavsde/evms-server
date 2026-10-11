import { type Kysely, sql } from 'kysely';

/**
 * Smart intake: any message or screenshot → draft moves → manager confirms.
 * - A move can exist before its container number is known (portal pendency gives counts only).
 * - Clients and places get aliases so "Nhava Sheva", "NSICT" or a portal group code ("ULA") match.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const id = sql`uuid PRIMARY KEY DEFAULT gen_random_uuid()`;
  const now = sql`timestamptz NOT NULL DEFAULT now()`;

  await sql`ALTER TABLE cargo ALTER COLUMN identifier DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE clients ADD COLUMN aliases jsonb NOT NULL DEFAULT '[]'`.execute(db);
  await sql`ALTER TABLE locations ADD COLUMN aliases jsonb NOT NULL DEFAULT '[]'`.execute(db);

  /** One pasted message/screenshot set, what the AI made of it, and what the manager confirmed. */
  await sql`CREATE TABLE intake_requests (
    id ${id},
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    source_text text,
    file_keys jsonb NOT NULL DEFAULT '[]',
    status text NOT NULL DEFAULT 'read' CHECK (status IN ('read','failed','confirmed','discarded')),
    provider text,
    model text,
    raw jsonb,                       -- the reader's answer as returned
    draft jsonb,                     -- after checks against master data
    error text,
    move_ids jsonb NOT NULL DEFAULT '[]',
    created_by uuid REFERENCES users(id),
    created_at ${now},
    confirmed_by uuid REFERENCES users(id),
    confirmed_at timestamptz
  )`.execute(db);
  await sql`CREATE INDEX intake_requests_tenant_idx ON intake_requests (tenant_id, created_at DESC)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS intake_requests`.execute(db);
  await sql`ALTER TABLE locations DROP COLUMN aliases`.execute(db);
  await sql`ALTER TABLE clients DROP COLUMN aliases`.execute(db);
  await sql`UPDATE cargo SET identifier = '' WHERE identifier IS NULL`.execute(db);
  await sql`ALTER TABLE cargo ALTER COLUMN identifier SET NOT NULL`.execute(db);
}

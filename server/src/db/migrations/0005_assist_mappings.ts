import { type Kysely, sql } from 'kysely';

/**
 * Smart paste learns each portal page once: which VMS data goes into which field. After a
 * manager confirms a fill, the next fill on that page needs no AI — for every manager.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE assist_mappings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    page_key text NOT NULL,          -- host + path, e.g. portal.nsft.com/eform13/import/cfseform13.aspx
    fields jsonb NOT NULL,           -- { fieldKey: { dataKey, label } }
    uses integer NOT NULL DEFAULT 0,
    updated_by uuid REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, page_key)
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS assist_mappings`.execute(db);
}

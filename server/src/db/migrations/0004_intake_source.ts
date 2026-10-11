import { type Kysely, sql } from 'kysely';

/** Where an intake came from: the Intake page, or the plugin with the page it copied from. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE intake_requests ADD COLUMN source jsonb NOT NULL DEFAULT '{"kind":"web"}'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE intake_requests DROP COLUMN source`.execute(db);
}

import { type Migration, type MigrationProvider, Migrator, NO_MIGRATIONS } from 'kysely';
import type { Db } from './client';
import * as m0001 from './migrations/0001_core';
import * as m0002 from './migrations/0002_operations_intelligence';
import * as m0003 from './migrations/0003_intake';
import * as m0004 from './migrations/0004_intake_source';
import * as m0005 from './migrations/0005_assist_mappings';
import * as m0006 from './migrations/0006_masters_access';

/**
 * Migrations are listed explicitly (works on Windows and when bundled).
 * Add new ones here in order: '0002_xxx': m0002.
 */
const migrations: Record<string, Migration> = {
  '0001_core': m0001,
  '0002_operations_intelligence': m0002,
  '0003_intake': m0003,
  '0004_intake_source': m0004,
  '0005_assist_mappings': m0005,
  '0006_masters_access': m0006,
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

export async function migrateToLatest(db: Db): Promise<void> {
  const { error } = await new Migrator({ db, provider }).migrateToLatest();
  if (error) throw error;
}

export async function migrateDown(db: Db): Promise<void> {
  const { error } = await new Migrator({ db, provider }).migrateDown();
  if (error) throw error;
}

/** Rolls back every migration (empty database). Used by "db:reset". */
export async function migrateAllDown(db: Db): Promise<void> {
  const { error } = await new Migrator({ db, provider }).migrateTo(NO_MIGRATIONS);
  if (error) throw error;
}

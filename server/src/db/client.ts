import { PGlite } from '@electric-sql/pglite';
import { Kysely, PostgresDialect } from 'kysely';
import { PGliteDialect } from 'kysely-pglite-dialect';
import pg from 'pg';
import type { Database } from './types';

export type Db = Kysely<Database>;

/**
 * DATABASE_URL forms:
 *   postgres://user:pass@host:5432/db  → real Postgres
 *   pglite:./.data/pg                  → embedded Postgres stored in a folder (zero setup)
 *   pglite:memory                      → in-memory (tests)
 */
export function createDb(url: string): Db {
  if (url.startsWith('pglite:')) {
    const target = url.slice('pglite:'.length);
    const pglite = target === 'memory' ? new PGlite() : new PGlite(target);
    return new Kysely<Database>({ dialect: new PGliteDialect(pglite) });
  }
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 10 }) }),
  });
}

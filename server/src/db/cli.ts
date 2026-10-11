/** npm run db:migrate | db:seed | db:reset (reset = down + latest + seed). */
import { mkdirSync } from 'node:fs';
import { loadEnv } from '../env';
import { createDb } from './client';
import { migrateAllDown, migrateToLatest } from './migrate';
import { seed } from './seed';

const env = loadEnv();
if (env.DATABASE_URL.startsWith('pglite:./'))
  mkdirSync(env.DATABASE_URL.slice(7), { recursive: true });
const db = createDb(env.DATABASE_URL);
const command = process.argv[2] ?? 'migrate';

try {
  if (command === 'reset') await migrateAllDown(db);
  await migrateToLatest(db);
  console.log('migrations: up to date');
  if (command === 'seed' || command === 'reset') {
    const r = await seed(db, env.FLOWS_DIR);
    console.log(r ? 'seed: demo data created' : 'seed: already present, skipped');
  }
} finally {
  await db.destroy();
}

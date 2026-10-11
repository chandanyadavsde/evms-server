import { mkdirSync } from 'node:fs';
import { buildApp } from './app';
import { createDb } from './db/client';
import { migrateToLatest } from './db/migrate';
import { seed, syncConfig } from './db/seed';
import { loadEnv, netSuiteConfig } from './env';
import { processPendingEvidence } from './modules/ai/service';
import { processOutbox } from './modules/billing/netsuite';
import { runForAllTenants } from './modules/exceptions/engine';

const env = loadEnv();
if (env.DATABASE_URL.startsWith('pglite:./'))
  mkdirSync(env.DATABASE_URL.slice(7), { recursive: true });

const db = createDb(env.DATABASE_URL);
await migrateToLatest(db);
// Local development starts with demo data so the team can try the full flow immediately.
if (env.NODE_ENV === 'development' && (await seed(db, env.FLOWS_DIR))) {
  console.log(
    'Demo data created. Sign in as manager@sorigin.co or driver 9000000001, code',
    env.DEV_OTP,
  );
}
if (env.NODE_ENV === 'development') await syncConfig(db, env.FLOWS_DIR);
const app = await buildApp(env, db);

// Background checks: the system watches the operation so managers don't have to.
const timer = setInterval(() => {
  runForAllTenants(db).catch((err) => app.log.error(err, 'exception checks failed'));
}, 60_000);
timer.unref();
// Push approved LRs to NetSuite; failures stay in the outbox with the reason and are retried.
const outboxTimer = setInterval(() => {
  processOutbox(db, netSuiteConfig(env)).catch((err) => app.log.error(err, 'outbox failed'));
}, 30_000);
outboxTimer.unref();
// Read driver-uploaded documents/photos with AI and flag mismatches.
const aiTimer = setInterval(() => {
  processPendingEvidence({ db, extractor: app.extractor, filesDir: env.FILES_DIR }).catch((err) =>
    app.log.error(err, 'evidence AI failed'),
  );
}, 20_000);
aiTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ port: env.PORT, host: '0.0.0.0' });

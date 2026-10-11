# evms-server

API for VMS EV (Fastify + TypeScript, PostgreSQL). Web app and Chrome plugin: **evms-client**.

## Run

```
npm install
cp .env.example .env        # then set DATABASE_URL (Neon or local Postgres) and AI keys
npm run dev                 # API on http://localhost:4100 — creates tables + demo data on first start
```

Demo logins (code 123456 in development): admin@sorigin.co, manager@sorigin.co, drivers 9000000001–9000000005.

- `npm run check` — lint + typecheck + tests (tests use an in-memory database, never your real one)
- `config/` — flows, rate cards, extraction templates (JSON, synced into the database on start)
- `packages/contracts` — shared definitions; **evms-client has a copy, keep both in step**

See CLAUDE.md for the architecture and rules.

# VMS EV

Config-driven vehicle management platform for EV container trucking (CFS ↔ Port, 20ft/40ft).
Built once as an engine; each client's flow, fields, documents and pricing are configuration.
Architecture: https://claude.ai/code/artifact/99fae995-0140-408a-916c-930cca504243
Roadmap: https://claude.ai/code/artifact/4fff3006-570d-4877-8d14-940e8ae0a068

## Layout

```
server/              Fastify + TypeScript API (modular monolith)
  src/domain         Pure engine logic: workflow, config resolution, capacity, screen builder, container no.
  src/modules        see "Modules" below
  src/db             Kysely client (Postgres or PGlite), table types, migrations, seed
client/              React + Vite web app (manager Mission Control + browser driver view)
extension/           Chrome plugin "VMS Assist" (MV3, esbuild): drag a box on any page → screenshot + exact page
                     text → /v1/intake/read. Build: npm run build:extension → load extension/dist unpacked
mobile/              Flutter driver app (owned by the mobile dev; see mobile/README.md)
packages/contracts   TypeBox schemas (Flow, Screen, RateCard, ExtractionTemplate); JSON Schema for Flutter
config/              flows/, rate-cards/, extraction-templates/ — JSON edited by testers/ops
```

## Commands

- `npm install` – all workspaces
- `npm run dev:server` – API on :4100 (embedded DB in server/.data, demo data on first start)
- `npm run dev:client` – web on :5180 (proxies /v1 to :4100)
- `npm run db:reset -w @vms/server` – drop, migrate, reseed
- `npm run check` – lint + typecheck + tests (pre-commit hook)
- `npm run build:extension` (or `dev:extension` to watch) – Chrome plugin into extension/dist
- `npm run export-schemas -w @vms/contracts` – regenerate JSON Schemas for Flutter

Demo logins (code 123456 in development): manager@sorigin.co, admin@sorigin.co, drivers 9000000001–9000000005.

## Core rules

- **Move ≠ Trip.** Move = demand (container A→B for a client). Trip = a truck's run, made of Legs.
  Round trip = append a Leg (`POST /v1/trips/:id/legs`), never recreate the Trip.
- **A move may wait for its container number** (portal pendency gives counts); the LR cannot be issued without it.
- **One LR = one client + one vehicle + one leg** (1×20, 2×20 or 1×40). Pre-LR at planning;
  issued/closed by flow automations (`lr.issue`, `lr.close`). Number prefix from client `billing.lrPrefix`.
- **Capacity is multi-dimensional** (`vehicle_categories.capacity`, `cargo_types.uses`). Use `domain/capacity.ts`.
- **Driver/vehicle are per leg** (`legs.assignment_id`), so drivers can change mid-trip.
- **Workflows run as `process_instances`** pinned to a config version; attachable to any entity.
- **Nothing client-specific in code.** Differences go in `config_definitions` (resolved by
  `domain/config-resolution.ts`), `custom` JSONB, or a flow field option (`validate`, `bind`, `rule`).
- **Server-driven UI.** Frontends render `Screen` JSON; they hold no business rules.
- **Every table has `tenant_id`**; every query filters by it.
- **Every state change writes an event** (`recordEvent`) — the memory of the "mini world".
- **User's saved language wins** over Accept-Language.

## Conventions

- TypeScript strict, ESM, `moduleResolution: Bundler`, run with `tsx` (no build step on the server yet).
- JSONB writes go through `json()` (lib/db-utils); numeric columns come back as strings → `num()`.
- Errors: throw `AppError` (lib/errors); 422 with `details: [{field, message}]` for field errors.
- New migration → add file in `server/src/db/migrations` AND register it in `db/migrate.ts`.
- Biome for lint/format (single quotes, 2 spaces, 100 cols). Tests: Vitest; end-to-end API tests
  in `server/test/app.test.ts` run on in-memory PGlite.

## Modules (server/src/modules)

auth (OTP→JWT) · admin (master data, documents, policy) · config (flows: validate/preview/publish) ·
operations (moves, trips, legs, step actions, Pre-LR/LR) · exceptions (engine, runs every 60 s) ·
billing (rate cards, pricing on LR close, approval, NetSuite outbox every 30 s) · ai (extraction templates,
vision model providers, background evidence reads every 20 s) · intake (any message/screenshot → draft moves → confirm) · assist (plugin smart paste: job data → portal form
fields; learned per page in assist_mappings, see domain/form-fill.ts) · dispatch (fleet state, suggestions, shadow mode,
opportunities, driver shifts + GPS, fleet dashboard) · files.

Config lives in config/: flows/, rate-cards/, extraction-templates/ — synced into the DB on dev start
(idempotent per version; bump `version` to change a published one).

Policy (thresholds, dispatch weights, autonomy levels) is tenant settings: lib/settings.ts has the defaults.

## Env worth knowing

- `AI_MODE` ocr (default: free local Tesseract, modules/ai/ocr.ts) | gemini | openrouter | claude | off. Providers sit behind
  `VisionModel` (modules/ai/llm.ts); features own their prompts and schemas. OCR picks fields using template
  hints (`labels`, `keywords`, `pattern`, `pick`, `scope`) and repairs container numbers via the check digit.
  Claude: `AI_MODEL` (default claude-opus-5-5), credentials via `ANTHROPIC_API_KEY` or an `ant auth login` profile.
  OpenRouter: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default google/gemini-2.5-flash-lite — keep it cheap; spend
  is logged per call and shown on the Intake page).
  Gemini: `GEMINI_API_KEY`, `GEMINI_MODEL` (default gemini-flash-latest); `GEMINI_TIER=free` shows a test-data-only banner.
- Smart intake (modules/intake): reader (LLM or rules+OCR) → `domain/intake.ts` checks against master data and
  aliases → draft with found/unsure/missing per field → manager confirms. A wrong guess must end up "unsure".
  `npm run eval:intake` scores the active reader on config/intake-samples.
- `NETSUITE_MODE` off|mock|restlet (+ `NETSUITE_*` TBA credentials). mock is refused in production.
- Tests never call an AI: pass a fake Extractor / IntakeReader to makeTestApp().
- Real documents and screenshots go in images/ (git-ignored): they hold driver phones, licences and client data.

## Not built yet

Flutter app · real SMS/email OTP · S3 storage · telematics · charger slot scheduling · fleet-wide optimiser ·
auto-dispatch at autonomy L3 · client portal · cloud deployment. NetSuite RESTlet mode is unverified against a real account.

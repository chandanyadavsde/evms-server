/**
 * Scores the active intake reader (AI_MODE) against config/intake-samples/samples.json.
 *   npm run eval:intake                 # uses .env (AI_MODE=ocr|gemini|claude|off)
 *   AI_MODE=gemini npm run eval:intake  # compare providers on the same samples
 * Each expected field that comes back right (and found or unsure-but-right) scores a point;
 * a wrong number of moves costs one point per missing or extra move.
 */
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { IntakeDraft } from '@vms/contracts';
import { createExtractor, createIntakeReader, createVisionModel } from '../app';
import { createDb } from '../db/client';
import { migrateToLatest } from '../db/migrate';
import { seed } from '../db/seed';
import { buildDraft, istToIso } from '../domain/intake';
import { loadEnv } from '../env';
import type { FileInput } from '../modules/ai/extractor';
import { loadIntakeMaster } from '../modules/intake/service';

interface Sample {
  name: string;
  now: string;
  text?: string;
  /** Screenshot files next to samples.json (use test or blurred images on a free key). */
  images?: string[];
  expect: { sourceKind: string; moves: Record<string, string>[] };
}

const SAMPLES_DIR = join(import.meta.dirname, '..', '..', '..', 'config', 'intake-samples');
const MEDIA: Record<string, FileInput['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const env = loadEnv();
const db = createDb('pglite:memory');
await migrateToLatest(db);
await seed(db, join(import.meta.dirname, '..', '..', '..', 'config', 'flows'));
const tenant = await db.selectFrom('tenants').select('id').executeTakeFirstOrThrow();
const master = await loadIntakeMaster(db, tenant.id);
const model = createVisionModel(env);
const reader = createIntakeReader(model, createExtractor(env, model));
const samples = JSON.parse(readFileSync(join(SAMPLES_DIR, 'samples.json'), 'utf8')) as Sample[];

console.log(`Reader: ${reader.name}\n`);
let total = 0;
let right = 0;
for (const s of samples) {
  const files: FileInput[] = (s.images ?? []).map((f) => ({
    data: readFileSync(join(SAMPLES_DIR, f)),
    mediaType: MEDIA[extname(f).toLowerCase()] ?? 'image/png',
  }));
  let draft: IntakeDraft;
  const started = Date.now();
  try {
    if (files.length && !reader.readsImages) throw new Error('reader cannot read images');
    const raw = await reader.read({ text: s.text ?? '', files }, master, new Date(s.now));
    draft = buildDraft(raw, master);
  } catch (err) {
    const points = 1 + s.expect.moves.reduce((n, m) => n + Object.keys(m).length, 0);
    total += points;
    console.log(`✗ ${s.name}: ${(err as Error).message} (0/${points})`);
    continue;
  }

  let points = 1;
  let got = draft.sourceKind === s.expect.sourceKind ? 1 : 0;
  const misses: string[] = got ? [] : [`kind ${draft.sourceKind}`];
  const extra = Math.abs(draft.moves.length - s.expect.moves.length);
  points += extra;
  if (extra) misses.push(`${draft.moves.length} moves, expected ${s.expect.moves.length}`);
  s.expect.moves.forEach((exp, i) => {
    const d = draft.moves[i];
    for (const [k, want] of Object.entries(exp)) {
      points++;
      const f = d?.[k as keyof typeof d];
      const field = f && typeof f === 'object' ? f : null;
      const ok =
        k === 'readyAt' || k === 'cutoffAt'
          ? field?.value === istToIso(want)
          : k === 'containerNumber'
            ? field?.value === want
            : field?.label === want;
      if (ok) got++;
      else misses.push(`#${i + 1} ${k}: got ${field?.label ?? field?.value ?? '—'}, want ${want}`);
    }
  });
  total += points;
  right += got;
  const ms = Date.now() - started;
  console.log(`${got === points ? '✓' : '△'} ${s.name}: ${got}/${points} (${ms} ms)`);
  for (const m of misses) console.log(`    ${m}`);
}
console.log(`\nScore: ${right}/${total} = ${total ? Math.round((right / total) * 100) : 0}%`);
await db.destroy();

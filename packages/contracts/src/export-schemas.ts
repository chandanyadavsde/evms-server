/**
 * Writes the contracts as plain JSON Schema files to packages/contracts/schemas/.
 * The Flutter app (and anyone not using TypeScript) builds against these files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtractionTemplate, FlowDefinition, IntakeDraft, RateCard, Screen } from './index';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
mkdirSync(outDir, { recursive: true });

for (const [name, schema] of Object.entries({
  FlowDefinition,
  Screen,
  RateCard,
  ExtractionTemplate,
  IntakeDraft,
})) {
  writeFileSync(join(outDir, `${name}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schemas/${name}.schema.json`);
}

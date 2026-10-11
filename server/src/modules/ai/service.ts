import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { type ExtractionResult, ExtractionTemplate, type FlowDefinition } from '@vms/contracts';
import { sql } from 'kysely';
import type { Db } from '../../db/client';
import { normalizeContainerNumber } from '../../domain/container-number';
import { json, num, recordEvent } from '../../lib/db-utils';
import { AppError, badRequest, notFound } from '../../lib/errors';
import type { AuthUser } from '../../plugins/auth';
import type { Extractor, FileInput } from './extractor';

// ─── Templates (configuration) ─────────────────────────────────────────────

export async function publishTemplate(db: Db, tenantId: string, template: unknown) {
  const errors = [...Value.Errors(ExtractionTemplate, template)].map(
    (e) => `${e.path || '/'}: ${e.message}`,
  );
  if (errors.length) throw new AppError(422, 'Template does not match schema', errors);
  const t = template as ExtractionTemplate;
  const existing = await db
    .selectFrom('config_definitions')
    .select(['id', 'version'])
    .where('tenant_id', '=', tenantId)
    .where('kind', '=', 'extraction_template')
    .where('key', '=', t.key)
    .orderBy('version', 'desc')
    .executeTakeFirst();
  if (existing && existing.version >= t.version) return existing.id;
  const row = await db
    .insertInto('config_definitions')
    .values({
      tenant_id: tenantId,
      kind: 'extraction_template',
      key: t.key,
      version: t.version,
      status: 'published',
      body: json(t),
      published_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function publishTemplatesFromDir(db: Db, tenantId: string, dir: string) {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  for (const f of files)
    await publishTemplate(db, tenantId, JSON.parse(readFileSync(join(dir, f), 'utf8')));
  return files;
}

export async function listTemplates(db: Db, tenantId: string): Promise<ExtractionTemplate[]> {
  const rows = await db
    .selectFrom('config_definitions')
    .select(['key', 'version', 'body'])
    .where('tenant_id', '=', tenantId)
    .where('kind', '=', 'extraction_template')
    .where('status', '=', 'published')
    .orderBy('key')
    .orderBy('version', 'desc')
    .execute();
  const latest = new Map<string, ExtractionTemplate>();
  for (const r of rows) if (!latest.has(r.key)) latest.set(r.key, r.body as ExtractionTemplate);
  return [...latest.values()];
}

async function getTemplate(db: Db, tenantId: string, key: string) {
  const t = (await listTemplates(db, tenantId)).find((x) => x.key === key);
  if (!t) throw notFound(`Extraction template "${key}"`);
  return t;
}

// ─── Running an extraction ────────────────────────────────────────────────

const MEDIA: Record<string, FileInput['mediaType']> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export async function loadFile(
  filesDir: string,
  tenantId: string,
  fileKey: string,
): Promise<FileInput> {
  if (!fileKey.startsWith(`${tenantId}/`) || fileKey.includes('..'))
    throw badRequest('File not found');
  const mediaType = MEDIA[extname(fileKey).toLowerCase()];
  if (!mediaType) throw badRequest('AI can read JPEG, PNG, WebP or PDF files');
  const data = await readFile(join(resolve(filesDir), fileKey)).catch(() => {
    throw badRequest('File not found');
  });
  if (data.length > 20 * 1024 * 1024) throw badRequest('File too large for AI reading (max 20 MB)');
  return { data, mediaType };
}

export interface AiDeps {
  db: Db;
  extractor: Extractor | null;
  filesDir: string;
}

/** Reads a file with a template and stores the result for review. Never changes operations by itself. */
export async function runExtraction(
  deps: AiDeps,
  user: AuthUser,
  input: { fileKey: string; templateKey: string },
) {
  const { db } = deps;
  const template = await getTemplate(db, user.tid, input.templateKey);
  const row = await db
    .insertInto('ai_extractions')
    .values({
      tenant_id: user.tid,
      kind: template.kind,
      template_key: template.key,
      file_key: input.fileKey,
      created_by: user.sub,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  if (!deps.extractor) {
    await db
      .updateTable('ai_extractions')
      .set({ status: 'failed', error: 'AI is not configured — enter the values manually' })
      .where('id', '=', row.id)
      .execute();
    return getExtraction(db, user.tid, row.id);
  }
  try {
    const file = await loadFile(deps.filesDir, user.tid, input.fileKey);
    const result = await deps.extractor.extract(template, file);
    const matches = template.applyToMoves ? await matchMoves(db, user.tid, result) : undefined;
    await db
      .updateTable('ai_extractions')
      .set({
        status: 'done',
        result: json({ ...result, ...(matches ? { matches } : {}) }),
        model: deps.extractor.model,
      })
      .where('id', '=', row.id)
      .execute();
  } catch (err) {
    await db
      .updateTable('ai_extractions')
      .set({
        status: 'failed',
        error: (err as Error).message.slice(0, 500),
        model: deps.extractor.model,
      })
      .where('id', '=', row.id)
      .execute();
  }
  return getExtraction(db, user.tid, row.id);
}

/** For portal screenshots: which open moves each extracted container belongs to. */
async function matchMoves(db: Db, tenantId: string, result: ExtractionResult) {
  const numbers = result.records
    .map((r) => r.container_number?.value)
    .filter((v): v is string => typeof v === 'string')
    .map(normalizeContainerNumber);
  if (!numbers.length) return {};
  const rows = await db
    .selectFrom('moves as m')
    .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
    .select(['m.id', 'm.status', 'c.identifier'])
    .where('m.tenant_id', '=', tenantId)
    .where('m.status', 'in', ['pending', 'planned', 'in_progress'])
    .where('c.identifier', 'in', numbers)
    .execute();
  const out: Record<string, { moveId: string; status: string }[]> = {};
  for (const r of rows) {
    if (!r.identifier) continue;
    out[r.identifier] = [...(out[r.identifier] ?? []), { moveId: r.id, status: r.status }];
  }
  return out;
}

export async function getExtraction(db: Db, tenantId: string, id: string) {
  const row = await db
    .selectFrom('ai_extractions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw notFound('Extraction');
  return row;
}

/**
 * A person confirms (and may correct) the values. For portal screenshots, matching moves get the
 * portal status — the "single status board" instead of opening five portals.
 */
export async function confirmExtraction(
  db: Db,
  user: AuthUser,
  id: string,
  records: Record<string, string | number | null>[],
) {
  const ex = await getExtraction(db, user.tid, id);
  if (ex.status !== 'done' && ex.status !== 'failed') throw badRequest(`Already ${ex.status}`);
  const template = await getTemplate(db, user.tid, ex.template_key ?? '');
  const updated: string[] = [];
  if (template.applyToMoves) {
    for (const r of records) {
      const number =
        typeof r.container_number === 'string'
          ? normalizeContainerNumber(r.container_number)
          : null;
      if (!number) continue;
      const moves = await db
        .selectFrom('moves as m')
        .innerJoin('cargo as c', 'c.id', 'm.cargo_id')
        .select(['m.id', 'm.custom'])
        .where('m.tenant_id', '=', user.tid)
        .where('m.status', 'in', ['pending', 'planned', 'in_progress'])
        .where('c.identifier', '=', number)
        .execute();
      for (const m of moves) {
        const portal = { ...r, checkedAt: new Date().toISOString(), source: `extraction:${id}` };
        const validTill =
          typeof r.valid_till === 'string' && !Number.isNaN(Date.parse(r.valid_till))
            ? new Date(r.valid_till)
            : null;
        await db
          .updateTable('moves')
          .set({
            custom: json({ ...m.custom, portal }),
            ...(validTill ? { cutoff_at: validTill } : {}),
          })
          .where('id', '=', m.id)
          .execute();
        await recordEvent(db, {
          tenantId: user.tid,
          entity: 'move',
          entityId: m.id,
          type: 'move.portal_status',
          actorId: user.sub,
          payload: { status: r.status ?? null, validTill: r.valid_till ?? null },
        });
        updated.push(m.id);
      }
    }
  }
  await db
    .updateTable('ai_extractions')
    .set({
      status: 'confirmed',
      corrected: json(records),
      confirmed_by: user.sub,
      confirmed_at: new Date(),
    })
    .where('id', '=', id)
    .execute();
  return { updatedMoves: updated };
}

// ─── Evidence captured by drivers ──────────────────────────────────────────

/**
 * Background: reads driver-uploaded documents/photos whose flow field asks for AI
 * (ai.extract / ai.read), stores the result on the evidence and raises an exception when it
 * disagrees with what the driver typed (container number, odometer).
 */
export async function processPendingEvidence(deps: AiDeps, limit = 10) {
  const { db, extractor } = deps;
  if (!extractor) return { processed: 0 };
  const pending = await db
    .selectFrom('evidence as e')
    .innerJoin('process_instances as p', 'p.id', 'e.process_instance_id')
    .select([
      'e.id',
      'e.tenant_id',
      'e.file_key',
      'e.ai_result',
      'e.step_key',
      'e.field_key',
      'p.captured',
      'p.entity',
      'p.entity_id',
      'p.definition_id',
    ])
    .where(sql<boolean>`e.ai_result->>'status' = 'pending'`)
    .limit(limit)
    .execute();
  for (const e of pending) {
    const req = e.ai_result as { status: string; template: string };
    try {
      const template = await getTemplate(db, e.tenant_id, req.template);
      const result = await extractor.extract(
        template,
        await loadFile(deps.filesDir, e.tenant_id, e.file_key ?? ''),
      );
      const first = result.records[0] ?? {};
      const issues: string[] = [];
      const typed = Object.assign(
        {},
        ...Object.values(e.captured as Record<string, Record<string, unknown>>),
      ) as Record<string, unknown>;
      const read = first.container_number?.value;
      if (
        typeof read === 'string' &&
        typeof typed.container_no === 'string' &&
        normalizeContainerNumber(typed.container_no) !== read
      ) {
        issues.push(
          `document shows ${read}, driver entered ${normalizeContainerNumber(typed.container_no)}`,
        );
      }
      const reading = num(first.reading?.value as number | null);
      const flow = (
        await db
          .selectFrom('config_definitions')
          .select('body')
          .where('id', '=', e.definition_id)
          .executeTakeFirstOrThrow()
      ).body as FlowDefinition;
      const step = flow.steps.find((s) => s.key === e.step_key);
      const bound = step?.fields.find((f) => f.bind && f.type === 'number');
      if (
        reading !== null &&
        bound &&
        typeof typed[bound.key] === 'number' &&
        Math.abs(reading - (typed[bound.key] as number)) > 1
      ) {
        issues.push(`photo reads ${reading}, driver entered ${typed[bound.key]}`);
      }
      await db
        .updateTable('evidence')
        .set({
          ai_result: json({
            status: 'done',
            template: req.template,
            model: extractor.model,
            result,
            issues,
          }),
        })
        .where('id', '=', e.id)
        .execute();
      if (issues.length) {
        await db
          .insertInto('exceptions')
          .values({
            tenant_id: e.tenant_id,
            entity: e.entity,
            entity_id: e.entity_id,
            type: 'document_mismatch',
            severity: 'warning',
            message: `${e.field_key.replace(/_/g, ' ')}: ${issues.join('; ')}`,
            proposal: json({ action: 'open_board', label: 'Check the evidence' }),
          })
          .onConflict((oc) =>
            oc
              .columns(['tenant_id', 'entity', 'entity_id', 'type'])
              .where('status', '=', 'open')
              .doNothing(),
          )
          .execute();
      }
    } catch (err) {
      await db
        .updateTable('evidence')
        .set({
          ai_result: json({
            status: 'failed',
            template: req.template,
            error: (err as Error).message.slice(0, 300),
          }),
        })
        .where('id', '=', e.id)
        .execute();
    }
  }
  return { processed: pending.length };
}

/** Which template reads a flow field (by document type or reading kind), if any. */
export async function templateForField(
  db: Db,
  tenantId: string,
  field: { docType?: string; ai?: { extract?: boolean; read?: string } },
) {
  if (!field.ai?.extract && !field.ai?.read) return null;
  const all = await listTemplates(db, tenantId);
  const t = field.ai.read
    ? all.find((x) => x.reads === field.ai?.read)
    : all.find((x) => field.docType && x.docTypes?.includes(field.docType));
  return t?.key ?? null;
}

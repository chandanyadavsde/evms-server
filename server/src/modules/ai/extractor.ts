import type { ExtractedRecord, ExtractionResult, ExtractionTemplate } from '@vms/contracts';
import { isValidContainerNumber, normalizeContainerNumber } from '../../domain/container-number';
import { type MediaType, ModelError, type VisionModel } from './llm';

/**
 * Reads structured fields from an image or PDF. A vision model does the reading; deterministic checks
 * (container check digit, number ranges) run afterwards. A person confirms before anything
 * changes in operations — the autonomy level can be raised later per template.
 */

export interface FileInput {
  data: Buffer;
  mediaType: MediaType;
}

export interface Extractor {
  readonly model: string;
  extract(template: ExtractionTemplate, file: FileInput): Promise<ExtractionResult>;
}

export class ExtractionError extends Error {}

/** JSON schema for structured output: one object per record, every field with value + confidence. */
export function outputSchema(t: ExtractionTemplate) {
  const field = {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'Exactly as shown; empty string if not visible' },
      confidence: {
        type: 'number',
        description: '0 to 1 — how sure you are the value is read correctly',
      },
    },
    required: ['value', 'confidence'],
    additionalProperties: false,
  };
  const record = {
    type: 'object',
    properties: Object.fromEntries(
      t.fields.map((f) => [
        f.key,
        { ...field, description: `${f.label}${f.hint ? ` — ${f.hint}` : ''}` },
      ]),
    ),
    required: t.fields.map((f) => f.key),
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      detected_as: {
        type: 'string',
        description: 'What this image/document is (portal name and page, document type)',
      },
      matches_template: {
        type: 'boolean',
        description: 'false if this is not the expected kind of document',
      },
      records: { type: 'array', items: record },
      notes: {
        type: 'string',
        description: 'Anything unreadable, cut off or suspicious; empty if none',
      },
    },
    required: ['detected_as', 'matches_template', 'records', 'notes'],
    additionalProperties: false,
  };
}

function instructions(t: ExtractionTemplate): string {
  return [
    `You read logistics documents for a container trucking company in India.`,
    `Expected input: ${t.description}`,
    t.multiple ? 'Return one record per container shown.' : 'Return exactly one record.',
    'Copy values exactly as printed. Never guess: if a value is not visible or not legible, return an empty string with confidence 0.',
    'Dates and times: ISO 8601 (YYYY-MM-DDTHH:mm), Indian Standard Time if no zone is shown.',
    'Numbers: digits only, no units or thousands separators.',
    'If the input is not this kind of document, set matches_template to false and return no records.',
  ].join('\n');
}

/** Reads a template's fields with any vision model (Claude, Gemini — see llm.ts). */
export class LlmExtractor implements Extractor {
  constructor(private llm: VisionModel) {}

  get model() {
    return this.llm.name;
  }

  async extract(t: ExtractionTemplate, file: FileInput): Promise<ExtractionResult> {
    try {
      const raw = await this.llm.json({
        system: instructions(t),
        parts: [file, { text: `Extract the fields for: ${t.name}.` }],
        schema: outputSchema(t),
      });
      return toResult(t, raw as RawOutput);
    } catch (err) {
      if (err instanceof ModelError) throw new ExtractionError(err.message);
      throw err;
    }
  }
}

interface RawOutput {
  detected_as: string;
  matches_template: boolean;
  records: Record<string, { value: string; confidence: number }>[];
  notes: string;
}

/** Normalises raw model output and applies deterministic checks. Exported for tests. */
export function toResult(t: ExtractionTemplate, raw: RawOutput): ExtractionResult {
  const records: ExtractedRecord[] = (raw.matches_template ? raw.records : []).map((r) => {
    const rec: ExtractedRecord = {};
    for (const f of t.fields) {
      const got = r[f.key];
      const text = (got?.value ?? '').trim();
      let confidence = Math.max(0, Math.min(1, Number(got?.confidence) || 0));
      let value: string | number | null = text || null;
      let check: { ok: boolean; message: string } | undefined;
      if (value !== null && f.type === 'number') {
        // Tolerate units and thousands separators: "12,460 km" → 12460.
        const match = String(value).match(/-?\d[\d,\s]*(\.\d+)?/);
        const n = match ? Number(match[0].replace(/[,\s]/g, '')) : Number.NaN;
        value = Number.isFinite(n) ? n : null;
        if (value === null) confidence = 0;
      }
      if (value !== null && f.type === 'container_number') {
        value = normalizeContainerNumber(String(value));
        const ok = isValidContainerNumber(value);
        check = {
          ok,
          message: ok ? 'Check digit OK' : 'Check digit does not match — likely misread',
        };
        if (!ok) confidence = Math.min(confidence, 0.3);
      }
      rec[f.key] = { value, confidence, ...(check ? { check } : {}) };
    }
    return rec;
  });
  return { detectedAs: raw.detected_as, records, notes: raw.notes };
}

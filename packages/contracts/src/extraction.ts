import { type Static, Type } from '@sinclair/typebox';
import { Key } from './common';

/**
 * Extraction template: what AI should read from one kind of image/PDF
 * (a port portal page, a port receipt, a gate slip, an odometer photo).
 * Configuration — a new portal or document type is a new template, not new code.
 */
export const ExtractionField = Type.Object(
  {
    key: Key,
    label: Type.String(),
    type: Type.Union([
      Type.Literal('string'),
      Type.Literal('number'),
      Type.Literal('datetime'),
      Type.Literal('container_number'),
    ]),
    /** Where to look / how it appears — helps the model on unfamiliar layouts. */
    hint: Type.Optional(Type.String()),
    required: Type.Optional(Type.Boolean()),
    // ── Hints for the free local OCR reader (ignored by AI models) ──
    /** Printed labels before the value, e.g. ["Receipt No", "Rcpt No"]. */
    labels: Type.Optional(Type.Array(Type.String())),
    /** Words/phrases the value is one of, e.g. status values. First found wins. */
    keywords: Type.Optional(Type.Array(Type.String())),
    /** Regex with one capture group for the value, e.g. "(\\d{1,3})\\s?%". */
    pattern: Type.Optional(Type.String()),
    /** On pages with many rows: read this field from the row (default) or from anywhere on the page. */
    scope: Type.Optional(Type.Union([Type.Literal('row'), Type.Literal('page')])),
    /** Which match to take when the pattern matches several times. */
    pick: Type.Optional(Type.Union([Type.Literal('first'), Type.Literal('largest')])),
  },
  { additionalProperties: false },
);

export const ExtractionTemplate = Type.Object(
  {
    key: Key,
    name: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    kind: Type.Union([
      Type.Literal('portal_screenshot'),
      Type.Literal('document'),
      Type.Literal('reading'),
    ]),
    /** Document types (from flow fields) this template reads, e.g. ["port_receipt"]. */
    docTypes: Type.Optional(Type.Array(Type.String())),
    /** Reading kind for photo fields (flow field ai.read), e.g. "odometer". */
    reads: Type.Optional(Type.String()),
    description: Type.String(),
    /** A portal page can list many containers: extract one row per container. */
    multiple: Type.Optional(Type.Boolean()),
    fields: Type.Array(ExtractionField, { minItems: 1 }),
    /** After confirmation: update matching moves (by container number) with these fields. */
    applyToMoves: Type.Optional(Type.Boolean()),
  },
  { $id: 'ExtractionTemplate', additionalProperties: false },
);
export type ExtractionTemplate = Static<typeof ExtractionTemplate>;

/** One extracted value with the model's confidence (0–1) and any deterministic check result. */
export interface ExtractedValue {
  value: string | number | null;
  confidence: number;
  check?: { ok: boolean; message: string };
}
export type ExtractedRecord = Record<string, ExtractedValue>;

export interface ExtractionResult {
  /** What the model thinks the image is, e.g. "NSICT container enquiry". */
  detectedAs: string;
  records: ExtractedRecord[];
  notes: string;
}

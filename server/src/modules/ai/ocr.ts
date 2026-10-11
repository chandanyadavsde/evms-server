import { mkdirSync } from 'node:fs';
import type {
  ExtractedRecord,
  ExtractedValue,
  ExtractionResult,
  ExtractionTemplate,
} from '@vms/contracts';
import { createWorker, type Worker } from 'tesseract.js';
import { containerCheckDigit } from '../../domain/container-number';
import { ExtractionError, type Extractor, type FileInput } from './extractor';

/**
 * Free, local reader: Tesseract OCR turns the image into text lines, then the template's hints
 * (labels, keywords, patterns) pick the fields. No account, no API key, nothing leaves the machine.
 * Less capable than a vision AI on messy photos — every value still goes through human review.
 */

export interface OcrLine {
  text: string;
  /** 0–100 from Tesseract. */
  confidence: number;
}

type Field = ExtractionTemplate['fields'][number];

// ── Container numbers: pattern + OCR look-alike fixes + ISO 6346 check digit ──

const TO_LETTER: Record<string, string[]> = {
  '0': ['O'],
  '1': ['I'],
  '5': ['S'],
  '8': ['B'],
  '2': ['Z'],
  '6': ['G'],
};
/** A letter where a digit belongs can be one of several look-alikes; the check digit decides. */
const TO_DIGIT: Record<string, string[]> = {
  O: ['0'],
  Q: ['0'],
  D: ['0'],
  I: ['1'],
  L: ['1'],
  S: ['5', '8'],
  B: ['8', '3'],
  Z: ['2', '7'],
  G: ['6'],
  T: ['7'],
  A: ['4'],
};
// Whole words only, so "2X20 MSKU9070323" is not read as "2X20MSKU907…" (which would hide the real number).
const CANDIDATE = /(?<![A-Z0-9])[A-Z0-9]{4}[\s-]?[A-Z0-9]{6}[\s-]?[A-Z0-9](?![A-Z0-9])/g;

function variants(chars: string[], map: Record<string, string[]>): string[] {
  let out = [''];
  for (const c of chars) {
    const opts = map[c] ?? [c];
    out = out.flatMap((prefix) => opts.map((o) => prefix + o));
    if (out.length > 64) return []; // too garbled to repair safely
  }
  return out;
}

/** Every valid container number in a line, with OCR look-alikes (O/0, I/1, S/5/8, B/8…) repaired. */
export function findContainerNumbers(line: string): { number: string; repaired: boolean }[] {
  const out: { number: string; repaired: boolean }[] = [];
  for (const m of line.toUpperCase().matchAll(CANDIDATE)) {
    const raw = m[0].replace(/[\s-]/g, '');
    const owners = variants(raw.slice(0, 4).split(''), TO_LETTER);
    const digitsList = variants(raw.slice(4).split(''), TO_DIGIT);
    const valid = owners
      .flatMap((o) => digitsList.map((d) => o + d))
      .filter(
        (n) =>
          /^[A-Z]{3}[UJZR]\d{7}$/.test(n) && containerCheckDigit(n.slice(0, 10)) === Number(n[10]),
      );
    // Exactly one valid reading = safe repair; several = ambiguous, leave it to the person.
    const fixed = valid.length === 1 ? valid[0] : undefined;
    if (fixed && !out.some((o) => o.number === fixed))
      out.push({ number: fixed, repaired: fixed !== raw });
  }
  return out;
}

// ── Dates: 08/10/2026 18:00 · 08-10-2026 · 08-Oct-2026 18:00 · 2026-10-08T18:00 ──

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Numeric months need a 4-digit year (so yard codes like "B12-04-3" are not dates); a named month
// may have a 2-digit year. Not preceded by a letter, digit or hyphen.
const DATE =
  /(?<![\w-])(?:(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2}))?|(\d{1,2})[/.\-\s](?:(\d{1,2})[/.\-\s](\d{4})|([A-Za-z]{3})[/.\-\s](\d{2,4}))(?:[\s,]+(\d{1,2}):(\d{2}))?)(?![\w])/;

export function findDate(text: string): string | null {
  const m = text.match(DATE);
  if (!m) return null;
  const pad = (n: string | number) => String(n).padStart(2, '0');
  let y: string;
  let mo: number;
  let d: string;
  let hh = '00';
  let mm = '00';
  if (m[1]) {
    [y, mo, d] = [m[1], Number(m[2]), m[3] as string];
    if (m[4]) [hh, mm] = [pad(m[4]), m[5] as string];
  } else {
    d = pad(m[6] as string);
    if (m[7]) {
      mo = Number(m[7]);
      y = m[8] as string;
    } else {
      mo = MONTHS.indexOf((m[9] as string).toLowerCase()) + 1;
      y = (m[10] as string).length === 2 ? `20${m[10]}` : (m[10] as string);
    }
    if (m[11]) [hh, mm] = [pad(m[11]), m[12] as string];
  }
  if (mo < 1 || mo > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${pad(mo)}-${pad(d)}T${hh}:${mm}`;
}

// ── Field rules ──

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();

function valueAfterLabel(
  lines: OcrLine[],
  labels: string[],
): { text: string; line: OcrLine } | null {
  for (const [i, line] of lines.entries()) {
    for (const label of labels) {
      const at = norm(line.text).indexOf(norm(label));
      if (at < 0) continue;
      // Value on the same line after the label (and a ":" or "-"), else the next line.
      const idx = line.text.toLowerCase().indexOf(label.toLowerCase());
      const rest = (idx >= 0 ? line.text.slice(idx + label.length) : '')
        .replace(/^[\s:.\-–#]+/, '')
        .trim();
      if (rest) return { text: rest, line };
      const next = lines[i + 1];
      if (next?.text.trim()) return { text: next.text.trim(), line: next };
    }
  }
  return null;
}

function byPattern(
  text: string,
  pattern: string,
  pick: 'first' | 'largest' = 'first',
): string | null {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'gi');
  } catch {
    return null;
  }
  const values = [...text.matchAll(re)].map((m) => m[1] ?? m[0]).filter(Boolean) as string[];
  if (!values.length) return null;
  if (pick === 'largest')
    return (
      values.sort((a, b) => Number(b.replace(/\D/g, '')) - Number(a.replace(/\D/g, '')))[0] ?? null
    );
  return values[0] ?? null;
}

function byKeywords(text: string, keywords: string[]): string | null {
  const t = norm(text);
  return keywords.find((k) => t.includes(norm(k))) ?? null;
}

const empty: ExtractedValue = { value: null, confidence: 0 };

/** Reads one field from a scope of lines (a table row for multi-record pages, else the whole page). */
function readField(f: Field, rowLines: OcrLine[], all: OcrLine[]): ExtractedValue {
  const scope = f.scope === 'page' ? all : rowLines;
  const conf = (l?: OcrLine) => (l ? l.confidence / 100 : 0.5);
  const scopeText = scope.map((l) => l.text).join('\n');
  const anyLine = scope[0];

  // 1. Printed label anywhere on the page → value after it.
  if (f.labels?.length) {
    const hit = valueAfterLabel(all, f.labels);
    if (hit) {
      const v =
        f.type === 'datetime'
          ? findDate(hit.text)
          : f.pattern
            ? byPattern(hit.text, f.pattern, f.pick)
            : hit.text.split(/\s{2,}|\|/)[0]?.trim();
      if (v) return { value: v, confidence: conf(hit.line) * 0.9 };
    }
  }
  // 2. One of a known set of words (status, terminal…).
  if (f.keywords?.length) {
    const k = byKeywords(scopeText, f.keywords);
    if (k) return { value: k, confidence: conf(anyLine) * 0.95 };
  }
  // 3. Pattern.
  if (f.pattern) {
    const v = byPattern(scopeText, f.pattern, f.pick);
    if (v) return { value: v, confidence: conf(anyLine) * 0.85 };
  }
  // 4. Type defaults.
  if (f.type === 'datetime') {
    const d = findDate(scopeText);
    if (d) return { value: d, confidence: conf(anyLine) * 0.8 };
  }
  return empty;
}

/** Pure: OCR lines + template → extraction result. Exported for tests. */
export function parseOcr(t: ExtractionTemplate, lines: OcrLine[]): ExtractionResult {
  const usable = lines.filter((l) => l.text.trim());
  const containerField = t.fields.find((f) => f.type === 'container_number');
  const records: ExtractedRecord[] = [];

  if (containerField && t.multiple) {
    // A portal page lists containers in rows: each row with a valid number is one record.
    for (const line of usable) {
      for (const c of findContainerNumbers(line.text)) {
        if (records.some((r) => r[containerField.key]?.value === c.number)) continue;
        const rec: ExtractedRecord = {};
        for (const f of t.fields) {
          rec[f.key] =
            f === containerField
              ? {
                  value: c.number,
                  // A repaired reading is probably right (the check digit agrees) but always gets a look.
                  confidence: c.repaired
                    ? Math.min(0.75, line.confidence / 100)
                    : Math.min(1, line.confidence / 100 + 0.15),
                  check: {
                    ok: true,
                    message: c.repaired
                      ? 'Check digit OK after fixing OCR look-alikes — please verify'
                      : 'Check digit OK',
                  },
                }
              : readField(f, [line], usable);
        }
        records.push(rec);
      }
    }
  } else {
    const rec: ExtractedRecord = {};
    for (const f of t.fields) {
      if (f.type === 'container_number') {
        const hit = usable.map((l) => ({ l, c: findContainerNumbers(l.text)[0] })).find((x) => x.c);
        rec[f.key] = hit?.c
          ? {
              value: hit.c.number,
              confidence: Math.min(1, hit.l.confidence / 100 + 0.15),
              check: { ok: true, message: 'Check digit OK' },
            }
          : empty;
      } else {
        rec[f.key] = readField(f, usable, usable);
      }
    }
    for (const f of t.fields) {
      const v = rec[f.key];
      if (v && v.value !== null && f.type === 'number') {
        const n = Number(String(v.value).replace(/[^\d.]/g, ''));
        rec[f.key] = Number.isFinite(n) && String(v.value).match(/\d/) ? { ...v, value: n } : empty;
      }
    }
    // Even a partial record is kept — the reviewer fills the gaps.
    if (Object.values(rec).some((v) => v.value !== null)) records.push(rec);
  }

  const missing = t.fields
    .filter((f) => f.required && !records.some((r) => r[f.key]?.value !== null))
    .map((f) => f.label);
  return {
    detectedAs: `${t.name} (read by local OCR)`,
    records,
    notes: [
      records.length
        ? ''
        : 'No matching values found — is this the right template, and is the image sharp?',
      missing.length && records.length ? `Not found: ${missing.join(', ')} — please fill in.` : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

export class OcrExtractor implements Extractor {
  readonly model = 'tesseract-ocr (local, free)';
  private worker: Promise<Worker> | null = null;
  constructor(private cachePath: string) {}

  private getWorker() {
    if (!this.worker) {
      mkdirSync(this.cachePath, { recursive: true });
      // First use downloads the English language data (~10 MB) once, then it is cached locally.
      this.worker = createWorker('eng', undefined, { cachePath: this.cachePath }).catch((err) => {
        this.worker = null;
        throw err;
      });
    }
    return this.worker;
  }

  async extract(t: ExtractionTemplate, file: FileInput): Promise<ExtractionResult> {
    if (file.mediaType === 'application/pdf') {
      throw new ExtractionError(
        'The free OCR reader reads images — upload a screenshot or photo of the PDF',
      );
    }
    const worker = await this.getWorker();
    const { data } = await worker.recognize(file.data, {}, { blocks: true, text: true });
    const lines: OcrLine[] = (data.blocks ?? []).flatMap((b) =>
      b.paragraphs.flatMap((p) => p.lines.map((l) => ({ text: l.text, confidence: l.confidence }))),
    );
    return parseOcr(
      t,
      lines.length
        ? lines
        : data.text.split('\n').map((text) => ({ text, confidence: data.confidence })),
    );
  }

  /** Plain text of an image, for readers that apply their own rules (smart intake). */
  async readText(file: FileInput): Promise<string> {
    if (file.mediaType === 'application/pdf') {
      throw new ExtractionError(
        'The free OCR reader reads images — upload a screenshot or photo of the PDF',
      );
    }
    const worker = await this.getWorker();
    const { data } = await worker.recognize(file.data);
    return data.text;
  }

  async close() {
    if (this.worker) await (await this.worker).terminate();
  }
}

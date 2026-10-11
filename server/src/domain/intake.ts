import {
  type DraftMove,
  type DraftMoveField,
  type IntakeDraft,
  type IntakeField,
  type PendencyRow,
  RequiredDraftFields,
} from '@vms/contracts';
import { isValidContainerNumber, normalizeContainerNumber } from './container-number';

/**
 * Smart intake, pure part: what any reader (Claude, Gemini, local rules) returns, and the checks
 * that turn it into a draft the manager confirms. A wrong guess must end up "unsure", never "found".
 */

// ─── What a reader returns ─────────────────────────────────────────────────

export interface RawValue {
  value: string;
  confidence: number;
}

export const RawItemKeys = [
  'client',
  'job_type',
  'from',
  'to',
  'size',
  'container_number',
  'count',
  'ready_at',
  'cutoff_at',
] as const;
export type RawItem = Record<(typeof RawItemKeys)[number], RawValue>;

export interface RawPendency {
  group: string;
  size: string;
  allocated: string;
  done: string;
  balance: string;
}

export interface RawIntake {
  source_kind: 'customer_order' | 'portal_pendency' | 'other';
  detected_as: string;
  summary: string;
  items: RawItem[];
  pendency: RawPendency[];
  notes: string;
}

// ─── Master data the checks match against ─────────────────────────────────

export interface IntakeMaster {
  clients: { id: string; code: string; name: string; aliases: string[] }[];
  locations: { id: string; code: string; name: string; type: string; aliases: string[] }[];
  cargoTypes: { id: string; code: string; name: string; size: string | null }[];
  jobTypes: { id: string; code: string; name: string; fromType: string; toType: string }[];
}

// ─── Prompt + output schema for vision models ─────────────────────────────

/** Today's date in India, YYYY-MM-DD. */
export function istDate(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function intakeInstructions(m: IntakeMaster, now: Date): string {
  const list = (xs: string[]) => xs.map((x) => `  - ${x}`).join('\n');
  return [
    'You read work requests for a container trucking company at JNPA (Nhava Sheva), India.',
    'The input is anything a manager pastes: a customer WhatsApp message, an email, or a screenshot of a port/CFS portal. It may be messy, in Hinglish, or several images.',
    '',
    'Decide source_kind:',
    '- customer_order: someone asks us to move containers. Return one item per container. If only a count and size are given (e.g. "2 x 20ft") without numbers, return ONE item with count set and container_number empty.',
    '- portal_pendency: a portal table of moves allocated / done / balance per size (e.g. an EFORM 13 "Pendency" box). Fill `pendency` (one row per group and size, skip sizes with all zeros): allocated = "Total Allocated Moves", done = "Generated PIN" (or completed), balance = "Balance". Leave `items` empty — a PIN or gate-pass form on the same screen is for a truck already planned, not a new order.',
    '- other: anything else. Explain in notes.',
    '',
    'Rules:',
    '- Never guess. If something is not in the input, return an empty string with confidence 0.',
    '- Where the text clearly refers to one of the known names below, return that known name exactly; otherwise copy the text as written and give a low confidence.',
    `- Times: "YYYY-MM-DDTHH:mm" in Indian time. Today is ${istDate(now)}. Resolve "today", "tomorrow", "4pm".`,
    '- size: "20", "40" or "45" (feet). container_number: 4 letters + 7 digits, as printed.',
    '- job_type: one of the job types below if the direction is clear, else empty.',
    '- summary: one short plain-English sentence of what is asked.',
    '',
    'Known clients (name, then other names):',
    list(m.clients.map((c) => [c.name, ...c.aliases].join(' | '))),
    'Known places (name [type], then other names):',
    list(m.locations.map((l) => `${[`${l.name} [${l.type}]`, l.code, ...l.aliases].join(' | ')}`)),
    'Job types (name: from type → to type):',
    list(m.jobTypes.map((j) => `${j.name}: ${j.fromType} → ${j.toType}`)),
  ].join('\n');
}

export function intakeSchema() {
  const value = {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'As read; empty string if not in the input' },
      confidence: { type: 'number', description: '0 to 1' },
    },
    required: ['value', 'confidence'],
    additionalProperties: false,
  };
  const str = { type: 'string' };
  return {
    type: 'object',
    properties: {
      source_kind: { type: 'string', enum: ['customer_order', 'portal_pendency', 'other'] },
      detected_as: { type: 'string', description: 'What the input is, e.g. "WhatsApp order"' },
      summary: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: Object.fromEntries(RawItemKeys.map((k) => [k, value])),
          required: [...RawItemKeys],
          additionalProperties: false,
        },
      },
      pendency: {
        type: 'array',
        items: {
          type: 'object',
          properties: { group: str, size: str, allocated: str, done: str, balance: str },
          required: ['group', 'size', 'allocated', 'done', 'balance'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string', description: 'Anything unclear, cut off or suspicious' },
    },
    required: ['source_kind', 'detected_as', 'summary', 'items', 'pendency', 'notes'],
    additionalProperties: false,
  };
}

// ─── Matching names ───────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Finds the record a name refers to: exact on name/code/alias → found; a unique partial match of
 * a long enough key → found; several or short partial matches → unsure.
 */
export function matchName<T extends { id: string; code: string; name: string; aliases: string[] }>(
  text: string,
  items: T[],
): { item: T | null; status: 'found' | 'unsure'; note?: string } {
  const t = norm(text);
  if (!t) return { item: null, status: 'unsure' };
  const keys = (i: T) => [i.name, i.code, ...i.aliases].map(norm).filter(Boolean);
  const exact = items.filter((i) => keys(i).includes(t));
  if (exact.length === 1) return { item: exact[0] as T, status: 'found' };
  const partial = items
    .map((i) => ({
      i,
      len: Math.max(0, ...keys(i).map((k) => (t.includes(k) || k.includes(t) ? k.length : 0))),
    }))
    .filter((x) => x.len >= 3);
  if (partial.length === 1) {
    const only = partial[0] as { i: T; len: number };
    return only.len >= 4
      ? { item: only.i, status: 'found' }
      : { item: only.i, status: 'unsure', note: 'Short match — please check' };
  }
  if (partial.length > 1) {
    return {
      item: null,
      status: 'unsure',
      note: `Could be ${partial.map((x) => x.i.name).join(' or ')}`,
    };
  }
  return { item: null, status: 'unsure', note: 'Not in master data — choose or add an alias' };
}

// ─── Building the draft ───────────────────────────────────────────────────

const LOW_CONFIDENCE = 0.7;
const MAX_COUNT = 50;

const missing = (note?: string): IntakeField => ({
  text: null,
  value: null,
  label: null,
  status: 'missing',
  ...(note ? { note } : {}),
});

function lowConfidence(f: IntakeField, confidence: number): IntakeField {
  if (f.status === 'found' && confidence < LOW_CONFIDENCE) {
    return { ...f, status: 'unsure', note: f.note ?? 'Not clearly readable — please check' };
  }
  return f;
}

function matchField<T extends { id: string; code: string; name: string; aliases: string[] }>(
  raw: RawValue | undefined,
  items: T[],
): { field: IntakeField; item: T | null } {
  const text = raw?.value?.trim() ?? '';
  if (!text) return { field: missing(), item: null };
  const m = matchName(text, items);
  const field: IntakeField = {
    text,
    value: m.item?.id ?? null,
    label: m.item?.name ?? null,
    status: m.item ? m.status : 'unsure',
    ...(m.note ? { note: m.note } : {}),
  };
  return { field: lowConfidence(field, raw?.confidence ?? 0), item: m.item };
}

export function sizeOf(text: string): string | null {
  const m = text.match(/\b(20|40|45)\b|(20|40|45)\s*(?:ft|'|’|feet|footer|hc)/i);
  return m ? `${m[1] ?? m[2]}ft` : null;
}

function sizeField(raw: RawValue | undefined, m: IntakeMaster): IntakeField {
  const text = raw?.value?.trim() ?? '';
  if (!text) return missing();
  const size = sizeOf(text);
  const ct = size ? m.cargoTypes.find((c) => c.size === size) : undefined;
  if (!ct) return { text, value: null, label: null, status: 'unsure', note: 'Unknown size' };
  return lowConfidence(
    { text, value: ct.id, label: ct.name, status: 'found' },
    raw?.confidence ?? 0,
  );
}

function containerField(raw: RawValue | undefined): IntakeField {
  const text = raw?.value?.trim() ?? '';
  if (!text) return missing('Can be added later');
  const number = normalizeContainerNumber(text);
  if (!isValidContainerNumber(number)) {
    return {
      text,
      value: number,
      label: number,
      status: 'unsure',
      note: 'Check digit does not match — likely misread',
    };
  }
  return lowConfidence(
    { text, value: number, label: number, status: 'found' },
    raw?.confidence ?? 0,
  );
}

/** "2026-10-08T16:00" (India time) → ISO instant. */
export function istToIso(local: string): string | null {
  const m = local.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${(m[2] as string).padStart(2, '0')}:${m[3]}:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function timeField(raw: RawValue | undefined): IntakeField {
  const text = raw?.value?.trim() ?? '';
  if (!text) return missing();
  const iso = istToIso(text);
  if (!iso)
    return { text, value: null, label: null, status: 'unsure', note: 'Time not understood' };
  return lowConfidence(
    { text, value: iso, label: text.replace('T', ' '), status: 'found' },
    raw?.confidence ?? 0,
  );
}

function jobTypeField(
  raw: RawValue | undefined,
  from: IntakeMaster['locations'][number] | null,
  to: IntakeMaster['locations'][number] | null,
  m: IntakeMaster,
): IntakeField {
  if (from && to) {
    const j = m.jobTypes.find((x) => x.fromType === from.type && x.toType === to.type);
    if (j) return { text: raw?.value || null, value: j.id, label: j.name, status: 'found' };
    return {
      text: raw?.value || null,
      value: null,
      label: null,
      status: 'unsure',
      note: `No job type for ${from.type} → ${to.type}`,
    };
  }
  const text = raw?.value?.trim() ?? '';
  if (!text) return missing();
  const j = matchName(
    text,
    m.jobTypes.map((x) => ({ ...x, aliases: [] })),
  ).item;
  return j
    ? { text, value: j.id, label: j.name, status: 'unsure', note: 'Check once places are set' }
    : { text, value: null, label: null, status: 'unsure', note: 'Unknown job type' };
}

function draftFromItem(item: Partial<RawItem>, m: IntakeMaster): DraftMove {
  const from = matchField(item.from, m.locations);
  const to = matchField(item.to, m.locations);
  return {
    client: matchField(item.client, m.clients).field,
    jobType: jobTypeField(item.job_type, from.item, to.item, m),
    size: sizeField(item.size, m),
    containerNumber: containerField(item.container_number),
    from: from.field,
    to: to.field,
    readyAt: timeField(item.ready_at),
    cutoffAt: timeField(item.cutoff_at),
  };
}

const toNum = (s: string) => {
  const n = Number(String(s ?? '').replace(/[^\d.-]/g, ''));
  return String(s ?? '').trim() === '' || !Number.isFinite(n) ? null : n;
};

const FIELD_NAMES: Record<DraftMoveField, string> = {
  client: 'Client',
  jobType: 'Job type',
  size: 'Size',
  containerNumber: 'Container number',
  from: 'Pickup',
  to: 'Drop',
  readyAt: 'Ready time',
  cutoffAt: 'Cut-off',
};

/** Turns a reader's answer into a draft: ids resolved, every field marked, questions listed. */
export function buildDraft(raw: RawIntake, m: IntakeMaster): IntakeDraft {
  const pendency: PendencyRow[] = (raw.pendency ?? [])
    .map((p) => ({
      group: (p.group ?? '').trim(),
      size: sizeOf(p.size ?? '') ?? (p.size ?? '').trim(),
      allocated: toNum(p.allocated),
      done: toNum(p.done),
      balance: toNum(p.balance),
    }))
    // Sizes with nothing allocated, done or pending are noise ("40ft: 0 0 0").
    .filter((p) => [p.allocated, p.done, p.balance].some((n) => n !== null && n !== 0));

  // On a portal page the pendency is the work: moves come from the balance only. Other things on
  // the screen (e.g. the PIN form for a truck already planned) must not become moves.
  const isPendency = pendency.length > 0;
  const moves: DraftMove[] = [];
  for (const item of isPendency ? [] : (raw.items ?? [])) {
    const draft = draftFromItem(item, m);
    const count = Math.round(toNum(item.count?.value ?? '') ?? 1);
    const copies = draft.containerNumber.value ? 1 : Math.min(Math.max(count, 1), MAX_COUNT);
    for (let i = 0; i < copies; i++) moves.push(structuredClone(draft));
  }
  const questions: string[] = [];
  for (const row of pendency) {
    if (row.balance && row.balance > 0) {
      // Each unplanned slot becomes a draft move; the portal gives no route or numbers.
      const draft = draftFromItem(
        { client: { value: row.group, confidence: 0.9 }, size: { value: row.size, confidence: 1 } },
        m,
      );
      for (let i = 0; i < Math.min(row.balance, MAX_COUNT); i++) moves.push(structuredClone(draft));
    } else if (row.balance === 0) {
      questions.push(`${row.group} ${row.size}: balance 0 — nothing left to plan.`);
    }
  }

  for (const f of RequiredDraftFields) {
    const open = moves.filter((d) => d[f].status !== 'found').length;
    if (open) {
      questions.push(
        `${FIELD_NAMES[f]}: ${open === moves.length ? 'not clear' : `not clear for ${open} of ${moves.length} moves`} — please choose.`,
      );
    }
  }
  const badNumbers = moves.filter(
    (d) => d.containerNumber.status === 'unsure' && d.containerNumber.value,
  ).length;
  if (badNumbers)
    questions.push(`Container number: ${badNumbers} failed the check digit — please check.`);

  return {
    sourceKind: isPendency ? 'portal_pendency' : (raw.source_kind ?? 'other'),
    detectedAs: raw.detected_as ?? '',
    summary: raw.summary ?? '',
    moves,
    pendency,
    questions,
    notes: raw.notes ?? '',
  };
}

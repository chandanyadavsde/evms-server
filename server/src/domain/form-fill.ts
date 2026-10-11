/**
 * Smart paste, pure part: which piece of VMS data goes into which field of someone else's form
 * (a port portal), and how to format it for that field. The AI (or simple rules) only decides the
 * data key per field; formatting and the learned mapping are deterministic, so a page that was
 * filled once is filled the same way next time without an AI call.
 */

export interface FormField {
  /** Stable id of the field on that page (its name or id attribute, else label + position). */
  key: string;
  label: string;
  kind: 'text' | 'number' | 'select' | 'date' | 'textarea' | 'radio' | 'checkbox';
  options?: string[];
  maxLength?: number;
}

/** The data a job can paste, with a human label per key. */
export const PASTE_KEYS = {
  truck_number: 'Truck registration number',
  driver_name: 'Driver name',
  driver_mobile: 'Driver mobile number',
  driver_licence: 'Driver licence (DL) number',
  container_count: 'Number of containers',
  container_size: 'Container size in feet (20 / 40 / 45)',
  container_numbers: 'Container numbers',
  client: 'Client (customer) name',
  pickup: 'Pickup place',
  drop: 'Drop place',
  job_type: 'Job type (import / export)',
  transporter: 'Our own company name — the transporter / truck company (never the client)',
} as const;
export type PasteKey = keyof typeof PASTE_KEYS;
export type PasteData = Partial<Record<PasteKey, string>>;

/** A learned page: field key → the data key that goes there ('' = leave empty). */
export type LearnedMapping = Record<string, { dataKey: PasteKey | ''; label: string }>;

export interface FillValue {
  key: string;
  dataKey: PasteKey | '';
  value: string;
  /** fill = we have a value; unknown = no VMS data fits (e.g. "BAT No"), left for the manager. */
  status: 'fill' | 'unknown';
  note?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Free fallback (no AI): obvious labels → data keys. */
export function guessDataKey(label: string): PasteKey | '' {
  const l = label.toLowerCase();
  if (/truck company|transporter|transport company|carrier/.test(l)) return 'transporter';
  if (/(^|\b)(tt|truck|vehicle|veh|lorry)\b.*(no|number|reg)|registration/.test(l))
    return 'truck_number';
  if (/driver.*(mobile|phone|contact)|mobile|phone|contact no/.test(l)) return 'driver_mobile';
  if (/licen[cs]e|\bdl\b/.test(l)) return 'driver_licence';
  if (/driver.*name|^name$/.test(l)) return 'driver_name';
  if (/(no\.?|number) of cont|container count|qty|quantity/.test(l)) return 'container_count';
  if (/\bsize\b/.test(l)) return 'container_size';
  if (/container.*(no|number)/.test(l)) return 'container_numbers';
  if (/client|customer|consignee/.test(l)) return 'client';
  return '';
}

/** Formats a data value for one field: picks the matching option, trims phone numbers. */
export function adaptValue(
  field: FormField,
  dataKey: PasteKey | '',
  raw: string | undefined,
): FillValue {
  const base = { key: field.key, dataKey };
  const value = (raw ?? '').trim();
  if (!dataKey || !value) {
    return {
      ...base,
      dataKey: '',
      value: '',
      status: 'unknown',
      note: 'No VMS data for this field',
    };
  }
  if (field.kind === 'select' || field.kind === 'radio') {
    const opts = field.options ?? [];
    const v = norm(value);
    const pick =
      opts.find((o) => norm(o) === v) ??
      opts.find((o) => norm(o).replace(/ft$/, '') === v.replace(/ft$/, '')) ??
      opts.find((o) => norm(o).startsWith(v) || (v.length > 2 && norm(o).includes(v)));
    return pick
      ? { ...base, value: pick, status: 'fill' }
      : { ...base, value: '', status: 'unknown', note: `"${value}" is not one of the options` };
  }
  let out = value;
  if (dataKey === 'driver_mobile') {
    // Indian portals usually show +91 separately and want the 10 digits.
    const digits = value.replace(/\D/g, '');
    out = digits.length > 10 ? digits.slice(-10) : digits;
  }
  if (dataKey === 'container_size') out = value.replace(/\D/g, '') || value;
  if (field.maxLength && out.length > field.maxLength) {
    return {
      ...base,
      value: out,
      status: 'fill',
      note: `Longer than the field allows (${field.maxLength})`,
    };
  }
  return { ...base, value: out, status: 'fill' };
}

/** True when every field on the form is already known for this page. */
export const fullyLearned = (fields: FormField[], learned: LearnedMapping | null) =>
  !!learned && fields.length > 0 && fields.every((f) => f.key in learned);

export function fillFromMapping(
  fields: FormField[],
  mapping: Record<string, PasteKey | ''>,
  data: PasteData,
): FillValue[] {
  return fields.map((f) => {
    const dk = mapping[f.key] ?? '';
    return adaptValue(f, dk, dk ? data[dk] : undefined);
  });
}

// ─── AI prompt + schema ───────────────────────────────────────────────────

export function fillInstructions(): string {
  return [
    'You help a container trucking company fill web forms on port portals from their own data.',
    'For each form field, decide which data item belongs in it. Use only the data given — never invent.',
    'If no data item fits a field (e.g. "BAT No", "RF ID", "PIN No" that the portal generates), return an empty data_key.',
    'Labels can be short or odd: "TT No" is the truck number, "Driving License No" is the driver licence, "No. Of Container" is the container count.',
    'We are the transporter: "Truck Company" / "Transporter" is our own company (transporter), never the client. A "Group Code" or line code is a portal code — leave it empty unless a data item is exactly that code.',
    'Data items:',
    ...Object.entries(PASTE_KEYS).map(([k, v]) => `- ${k}: ${v}`),
  ].join('\n');
}

export function fillSchema() {
  return {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            data_key: { type: 'string', enum: ['', ...Object.keys(PASTE_KEYS)] },
          },
          required: ['key', 'data_key'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields'],
    additionalProperties: false,
  };
}

export function fillPrompt(fields: FormField[], data: PasteData): string {
  return [
    'Form fields (key · label · kind · options):',
    ...fields.map(
      (f) =>
        `- ${f.key} · "${f.label}" · ${f.kind}${f.options?.length ? ` · [${f.options.slice(0, 20).join(' | ')}]` : ''}`,
    ),
    '',
    'Data available for this job (key = value):',
    ...Object.entries(data)
      .filter(([, v]) => v)
      .map(([k, v]) => `- ${k} = ${v}`),
  ].join('\n');
}

/** Page identity for learning: host + path, without query strings or fragments. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

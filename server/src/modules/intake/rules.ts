import {
  type IntakeMaster,
  istDate,
  type RawIntake,
  type RawItem,
  type RawPendency,
  type RawValue,
} from '../../domain/intake';
import type { FileInput } from '../ai/extractor';
import { findContainerNumbers, findDate } from '../ai/ocr';
import { IntakeError, type IntakeInput, type IntakeReader } from './reader';

/**
 * Free fallback reader: plain rules over text (typed, pasted, or OCR'd from a screenshot).
 * Good for clean messages ("2x20 MSKU… NSICT to CFS Alpha ready 4pm"); messy ones need an AI.
 */

const v = (value: string | null | undefined, confidence = 0.9): RawValue =>
  value ? { value, confidence } : { value: '', confidence: 0 };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where in the text each known record is first mentioned (by name, code or alias). */
function mentions<T extends { name: string; code: string; aliases: string[] }>(
  text: string,
  items: T[],
): { item: T; at: number; as: string }[] {
  const out: { item: T; at: number; as: string }[] = [];
  for (const item of items) {
    let best: { at: number; as: string } | null = null;
    for (const key of [item.name, item.code, ...item.aliases]) {
      if (!key || key.length < 2) continue;
      const m = new RegExp(`(?<![a-z0-9])${escapeRegex(key)}(?![a-z0-9])`, 'i').exec(text);
      if (m && (!best || m.index < best.at)) best = { at: m.index, as: m[0] };
    }
    if (best) out.push({ item, ...best });
  }
  return out.sort((a, b) => a.at - b.at);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "ready 4pm", "kal 10:30", "08/10/2026 18:00" → "2026-10-08T16:00" (India time). */
export function findTime(segment: string, now: Date): string | null {
  const full = findDate(segment);
  if (full && !full.endsWith('T00:00')) return full;
  let day = istDate(now);
  if (/\b(tomorrow|tmrw|kal)\b/i.test(segment)) day = addDays(day, 1);
  if (full) day = full.slice(0, 10);
  const ampm = segment.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  const h24 = segment.match(/\b(\d{1,2}):(\d{2})\b/);
  // Hinglish: "subah 10 baje", "sham 6 baje", "dopahar 2 baje"
  const baje = segment.match(
    /\b(?:(subah|sawere|dopahar|dophar|sham|shaam|raat)\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*baje\b/i,
  );
  let hh: number | null = null;
  let mm = 0;
  if (ampm) {
    hh = (Number(ampm[1]) % 12) + (/pm/i.test(ampm[3] as string) ? 12 : 0);
    mm = Number(ampm[2] ?? 0);
  } else if (baje) {
    const h = Number(baje[2]);
    const pm = /dopahar|dophar|sham|shaam|raat/i.test(baje[1] ?? '') && h < 12;
    hh = pm ? h + 12 : h;
    mm = Number(baje[3] ?? 0);
  } else if (h24) {
    hh = Number(h24[1]);
    mm = Number(h24[2]);
  }
  if (hh === null) return full;
  if (hh > 23 || mm > 59) return null;
  return `${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const READY_WORDS = /\b(ready|available|pick\s*-?up|reporting|placement)\b/gi;
const CUTOFF_WORDS = /\b(cut\s*-?\s*off|deadline|before|latest\s+by)\b/gi;

/**
 * The first time stated after one of the keywords, reading only up to the next clause
 * ("ready today 4pm, cut-off …" → today 16:00). Keywords without a time ("arrange pickup of…") are skipped.
 */
function timeAfter(text: string, words: RegExp, now: Date): string | null {
  for (const m of text.matchAll(words)) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const clause = rest.split(/[,;\n]|\b(?:cut\s*-?\s*off|deadline|ready|available)\b/i)[0] ?? '';
    const t = findTime(clause, now);
    if (t) return t;
  }
  return null;
}

/** Pickup and drop: "from X" / "to X" decide; otherwise the first place named is the pickup. */
function route<T>(text: string, places: { item: T; at: number }[]): { from?: T; to?: T } {
  const role = (at: number) => {
    const before = text.slice(Math.max(0, at - 14), at);
    if (/\b(to|till|upto|drop(?:\s+at)?|deliver(?:\s+to|\s+at)?)\s*$/i.test(before)) return 'to';
    if (/\b(from|ex|pick\s*-?up(?:\s+from)?)\s*$/i.test(before)) return 'from';
    return null;
  };
  const tagged = places.map((p) => ({ ...p, role: role(p.at) }));
  const from = tagged.find((p) => p.role === 'from') ?? tagged.find((p) => !p.role);
  const to = tagged.find((p) => p.role === 'to') ?? tagged.find((p) => !p.role && p !== from);
  return { ...(from ? { from: from.item } : {}), ...(to ? { to: to.item } : {}) };
}

/** "2x20", "2 x 40ft", "20' x 3", "3 nos 20ft", or just "40ft". */
export function findSizeAndCount(text: string): { size: string; count: number } | null {
  const patterns: [RegExp, number, number][] = [
    [/\b(\d{1,2})\s*[x×*]\s*(20|40|45)(?!\d)/i, 2, 1],
    [/\b(20|40|45)\s*(?:ft|'|’|feet|footer)?\s*[x×*]\s*(\d{1,2})\b/i, 1, 2],
    [
      /\b(\d{1,2})\s*(?:nos?\.?|containers?|cntrs?|boxes|units?)\s*(?:of\s*)?(20|40|45)(?!\d)/i,
      2,
      1,
    ],
  ];
  for (const [re, s, c] of patterns) {
    const m = text.match(re);
    if (m) return { size: m[s] as string, count: Number(m[c]) };
  }
  const only = text.match(/\b(20|40|45)\s*(?:ft|'|’|feet|footer|hc|gp)/i);
  return only ? { size: only[1] as string, count: 1 } : null;
}

/** EFORM 13-style "Pendency" box: sizes across, allocated / done / balance rows. */
export function findPendency(text: string): RawPendency[] {
  if (!/pendency|allocated/i.test(text)) return [];
  const group =
    text.match(/\b([A-Z][A-Z0-9]{1,9})\s*\|?\s*[Pp]endency/)?.[1] ??
    text.match(/group\s*code\s*[:-]?\s*([A-Z0-9]{2,10})/i)?.[1] ??
    '';
  // Cells may be separated by spaces (OCR) or " | " (page text from the plugin).
  const row = (re: RegExp) =>
    (text.match(re)?.[1] ?? '')
      .trim()
      .split(/[\s|]+/)
      .filter(Boolean);
  const header = text.split('\n').find((l) => /\b20\b.*\b40\b/.test(l));
  const sizes = header?.match(/\b(20|40|45)\b/g) ?? ['20', '40', '45'];
  const allocated = row(/allocated[^\d\n]*((?:\d+[ \t|]*)+)/i);
  const done = row(/(?:generated\s*pin|pin\s*generated|completed|done)[^\d\n]*((?:\d+[ \t|]*)+)/i);
  const balance = row(/balance[^\d\n]*((?:\d+[ \t|]*)+)/i);
  if (!allocated.length && !balance.length) return [];
  return sizes
    .map((size, i) => ({
      group,
      size,
      allocated: allocated[i] ?? '',
      done: done[i] ?? '',
      balance: balance[i] ?? '',
    }))
    .filter((r) => [r.allocated, r.done, r.balance].some((x) => x && x !== '0'));
}

export function readByRules(text: string, master: IntakeMaster, now: Date): RawIntake {
  const pendency = findPendency(text);
  if (pendency.length) {
    return {
      source_kind: 'portal_pendency',
      detected_as: 'Portal pendency (read by rules)',
      summary: pendency
        .map(
          (p) =>
            `${p.group || 'Group ?'} ${p.size}ft: allocated ${p.allocated || '?'}, balance ${p.balance || '?'}`,
        )
        .join('; '),
      items: [],
      pendency,
      notes: '',
    };
  }
  if (/pendency/i.test(text)) {
    // A pendency box whose numbers did not survive OCR: say so rather than guess an order.
    return {
      source_kind: 'portal_pendency',
      detected_as: 'Portal pendency (read by rules)',
      summary: '',
      items: [],
      pendency: [],
      notes:
        'A pendency box is visible but its numbers could not be read. Use an AI reader (AI_MODE=gemini or claude), or create the moves by hand.',
    };
  }

  const numbers = [
    ...new Set(text.split('\n').flatMap((l) => findContainerNumbers(l).map((c) => c.number))),
  ];
  const sizeCount = findSizeAndCount(text);
  const places = mentions(text, master.locations);
  const { from, to } = route(text, places);
  const named = (item: unknown) => places.find((p) => p.item === item)?.as;
  const client = mentions(text, master.clients)[0];
  const cutoff = timeAfter(text, CUTOFF_WORDS, now);
  // No "ready" keyword: a time stated before any cut-off is the ready time ("kal subah 10 baje …").
  const beforeCutoff = text.split(CUTOFF_WORDS)[0] ?? text;
  const ready = timeAfter(text, READY_WORDS, now) ?? findTime(beforeCutoff, now);
  const job = /\bimport\b/i.test(text) ? 'import' : /\bexport\b/i.test(text) ? 'export' : '';

  if (!numbers.length && !sizeCount && places.length === 0) {
    return {
      source_kind: 'other',
      detected_as: 'Text (read by rules)',
      summary: '',
      items: [],
      pendency: [],
      notes:
        'No containers, sizes or known places found. Try an AI reader (AI_MODE) for messy messages.',
    };
  }

  const base: Omit<RawItem, 'container_number' | 'count'> = {
    client: v(client?.as),
    job_type: v(job, 0.6),
    from: v(named(from)),
    to: v(named(to)),
    size: v(sizeCount?.size),
    ready_at: v(ready),
    cutoff_at: v(cutoff),
  };
  const items: RawItem[] = numbers.length
    ? numbers.map((n) => ({ ...base, container_number: v(n), count: v('1') }))
    : [{ ...base, container_number: v(''), count: v(String(sizeCount?.count ?? 1)) }];
  const what = `${numbers.length || sizeCount?.count || 1} × ${sizeCount ? `${sizeCount.size}ft` : 'container'}`;
  return {
    source_kind: 'customer_order',
    detected_as: 'Text message (read by rules)',
    summary: `${what}${from ? ` from ${from.name}` : ''}${to ? ` to ${to.name}` : ''}${client ? ` for ${client.item.name}` : ''}.`,
    items,
    pendency: [],
    notes: '',
  };
}

/** Reads text with rules; screenshots go through local OCR first (when AI_MODE=ocr). */
export class RuleIntakeReader implements IntakeReader {
  readonly name: string;
  readonly readsImages: boolean;
  constructor(private ocr: { readText(file: FileInput): Promise<string> } | null) {
    this.name = ocr ? 'rules + local OCR (free)' : 'rules (text only)';
    this.readsImages = !!ocr;
  }

  async read(input: IntakeInput, master: IntakeMaster, now: Date): Promise<RawIntake> {
    const parts = [input.text ?? ''];
    if (input.files.length) {
      if (!this.ocr) {
        throw new IntakeError(
          'Reading images is off on this server — paste the message text instead, or set AI_MODE to ocr, gemini or claude.',
        );
      }
      for (const f of input.files) parts.push(await this.ocr.readText(f));
    }
    const raw = readByRules(parts.join('\n'), master, now);
    if (!input.files.length || !raw.items.length) return raw;
    // OCR of a screenshot also reads tabs, bookmarks and the clock: nothing from it counts as "found".
    const doubt = (v: RawValue): RawValue => ({ ...v, confidence: Math.min(v.confidence, 0.5) });
    return {
      ...raw,
      items: raw.items.map(
        (it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, doubt(v)])) as RawItem,
      ),
      notes: [raw.notes, 'Read from a screenshot by free OCR — please check every field.']
        .filter(Boolean)
        .join(' '),
    };
  }
}

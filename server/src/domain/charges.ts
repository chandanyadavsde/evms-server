import type { ChargeLine, ExtraCharge, RateCard, RateLine } from '@vms/contracts';
import { localize } from './i18n';

/**
 * Prices an LR from a rate card. Pure: the caller supplies containers and the leg's step timeline.
 * Each container gets the most specific matching line; extras (detention, tolls) come from config.
 */

export interface PricedContainer {
  number: string;
  size: string;
  state: 'loaded' | 'empty';
}

export interface PricingInput {
  jobType: string;
  from: string; // place code
  to: string;
  containers: PricedContainer[];
  /** Step key → when it was entered / completed (from the leg's event log). */
  timeline: Record<string, { entered?: Date; completed?: Date }>;
}

export interface PricingResult {
  lines: ChargeLine[];
  total: number;
  /** Containers no line matched — the LR can't be billed until the rate card covers them. */
  unpriced: string[];
}

type MatchKeys = keyof RateLine['match'];

function matches(
  match: RateLine['match'] | undefined,
  input: PricingInput,
  c?: PricedContainer,
): number {
  if (!match) return 0;
  const actual: Record<MatchKeys, string | undefined> = {
    jobType: input.jobType,
    size: c?.size,
    from: input.from,
    to: input.to,
    state: c?.state,
  };
  let score = 0;
  for (const [k, v] of Object.entries(match) as [MatchKeys, string | undefined][]) {
    if (v === undefined) continue;
    if (actual[k] !== v) return -1;
    score++;
  }
  return score;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function pointTime(
  input: PricingInput,
  p: { step: string; at: 'entered' | 'completed' },
): Date | undefined {
  return input.timeline[p.step]?.[p.at];
}

export function priceLr(card: RateCard, input: PricingInput, lang = 'en'): PricingResult {
  const lines: ChargeLine[] = [];
  const unpriced: string[] = [];

  // Per-container lines: most specific match wins.
  const containerLines = card.lines.filter((l) => l.per === 'container');
  for (const c of input.containers) {
    const best = containerLines
      .map((l) => ({ l, score: matches(l.match, input, c) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)[0];
    if (!best) {
      unpriced.push(c.number);
      continue;
    }
    lines.push({
      code: best.l.code,
      label: `${localize(best.l.label, lang)} · ${c.number}`,
      quantity: 1,
      unit: 'container',
      rate: best.l.amount,
      amount: best.l.amount,
      basis: `rate card ${card.key} v${card.version}`,
    });
  }

  // Per-LR lines (e.g. a documentation fee).
  for (const l of card.lines.filter((x) => x.per === 'lr')) {
    if (matches(l.match, input) < 0) continue;
    lines.push({
      code: l.code,
      label: localize(l.label, lang),
      quantity: 1,
      unit: 'LR',
      rate: l.amount,
      amount: l.amount,
      basis: `rate card ${card.key} v${card.version}`,
    });
  }

  for (const e of card.extras ?? []) {
    const line = extraLine(e, input, lang);
    if (line) lines.push(line);
  }

  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  return { lines, total, unpriced };
}

function extraLine(e: ExtraCharge, input: PricingInput, lang: string): ChargeLine | null {
  if (e.basis === 'fixed') {
    if (e.match && matches(e.match, input, input.containers[0]) < 0) return null;
    return {
      code: e.code,
      label: localize(e.label, lang),
      quantity: 1,
      unit: 'each',
      rate: e.amount,
      amount: e.amount,
      basis: 'fixed extra',
    };
  }
  const start = pointTime(input, e.from);
  const end = pointTime(input, e.to);
  if (!start || !end) return null;
  const minutes = (end.getTime() - start.getTime()) / 60000;
  const chargeable = minutes - e.freeMinutes;
  if (chargeable <= 0) return null;
  const hours = e.roundUpHours === false ? round2(chargeable / 60) : Math.ceil(chargeable / 60);
  return {
    code: e.code,
    label: localize(e.label, lang),
    quantity: hours,
    unit: 'hour',
    rate: e.ratePerHour,
    amount: round2(hours * e.ratePerHour),
    basis: `${Math.round(minutes)} min from ${e.from.step} to ${e.to.step}, ${e.freeMinutes} min free`,
  };
}

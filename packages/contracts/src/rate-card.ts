import { type Static, Type } from '@sinclair/typebox';
import { Key, LocalizedText } from './common';

/**
 * Rate card: a client's prices as configuration (config_definitions, kind = 'rate_card').
 * Resolved like flows: company default → region → client. Versioned; an LR records which version priced it.
 */

/** Which containers a price line applies to. Omitted fields match anything; more fields = more specific. */
export const RateMatch = Type.Object(
  {
    jobType: Type.Optional(Type.String()),
    size: Type.Optional(Type.String()),
    from: Type.Optional(Type.String()), // place code
    to: Type.Optional(Type.String()),
    state: Type.Optional(Type.Union([Type.Literal('loaded'), Type.Literal('empty')])),
  },
  { additionalProperties: false },
);

export const RateLine = Type.Object(
  {
    code: Key,
    label: LocalizedText,
    match: RateMatch,
    amount: Type.Number({ minimum: 0 }),
    per: Type.Union([Type.Literal('container'), Type.Literal('lr')]),
  },
  { additionalProperties: false },
);

/** A point in a leg's timeline: when a step was entered or completed. */
export const StepPoint = Type.Object(
  { step: Key, at: Type.Union([Type.Literal('entered'), Type.Literal('completed')]) },
  { additionalProperties: false },
);

export const ExtraCharge = Type.Union([
  Type.Object(
    {
      code: Key,
      label: LocalizedText,
      basis: Type.Literal('duration'),
      /** e.g. detention: from gate-in (reach_pickup completed) to gate-out completed. */
      from: StepPoint,
      to: StepPoint,
      freeMinutes: Type.Integer({ minimum: 0 }),
      ratePerHour: Type.Number({ minimum: 0 }),
      /** Charged per started hour (true) or pro-rata (false). */
      roundUpHours: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      code: Key,
      label: LocalizedText,
      basis: Type.Literal('fixed'),
      amount: Type.Number({ minimum: 0 }),
      match: Type.Optional(RateMatch),
    },
    { additionalProperties: false },
  ),
]);

export const RateCard = Type.Object(
  {
    key: Key,
    name: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    currency: Type.String({ minLength: 3, maxLength: 3 }),
    lines: Type.Array(RateLine, { minItems: 1 }),
    extras: Type.Optional(Type.Array(ExtraCharge)),
  },
  { $id: 'RateCard', additionalProperties: false },
);
export type RateCard = Static<typeof RateCard>;
export type RateLine = Static<typeof RateLine>;
export type ExtraCharge = Static<typeof ExtraCharge>;

/** A calculated charge on an LR. */
export const ChargeLine = Type.Object({
  code: Type.String(),
  label: Type.String(),
  quantity: Type.Number(),
  unit: Type.String(),
  rate: Type.Number(),
  amount: Type.Number(),
  basis: Type.String(),
  /** Set when a person changed the line during approval. */
  adjustedBy: Type.Optional(Type.String()),
});
export type ChargeLine = Static<typeof ChargeLine>;

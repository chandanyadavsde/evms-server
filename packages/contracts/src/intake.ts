import { type Static, Type } from '@sinclair/typebox';

/**
 * Smart intake: any customer message or portal screenshot → draft moves for the manager to confirm.
 * The reader (Claude, Gemini or local rules) returns names as written; checks against master data
 * turn them into ids and mark each field found / unsure / missing.
 */

export const FieldStatus = Type.Union([
  Type.Literal('found'),
  Type.Literal('unsure'),
  Type.Literal('missing'),
]);
export type FieldStatus = Static<typeof FieldStatus>;

export const IntakeField = Type.Object({
  /** What the message said, as read ("NSICT", "4pm", "20'"). */
  text: Type.Union([Type.String(), Type.Null()]),
  /** Resolved value: a master-data id, an ISO time or a normalised container number. */
  value: Type.Union([Type.String(), Type.Null()]),
  /** Human label of the resolved value ("NSICT (DP World)"). */
  label: Type.Union([Type.String(), Type.Null()]),
  status: FieldStatus,
  note: Type.Optional(Type.String()),
});
export type IntakeField = Static<typeof IntakeField>;

export const DraftMoveFields = [
  'client',
  'jobType',
  'size',
  'containerNumber',
  'from',
  'to',
  'readyAt',
  'cutoffAt',
] as const;
export type DraftMoveField = (typeof DraftMoveFields)[number];

/** Fields a move cannot be created without. The container number may follow later. */
export const RequiredDraftFields: DraftMoveField[] = ['client', 'jobType', 'size', 'from', 'to'];

export const DraftMove = Type.Object({
  client: IntakeField,
  jobType: IntakeField,
  size: IntakeField,
  containerNumber: IntakeField,
  from: IntakeField,
  to: IntakeField,
  readyAt: IntakeField,
  cutoffAt: IntakeField,
  /** An open move already has this container number. */
  duplicateOf: Type.Optional(Type.String()),
});
export type DraftMove = Static<typeof DraftMove>;

/** One row of a portal pendency table ("ULA · 20ft · allocated 1 · PIN made 1 · balance 0"). */
export const PendencyRow = Type.Object({
  group: Type.String(),
  size: Type.String(),
  allocated: Type.Union([Type.Number(), Type.Null()]),
  done: Type.Union([Type.Number(), Type.Null()]),
  balance: Type.Union([Type.Number(), Type.Null()]),
});
export type PendencyRow = Static<typeof PendencyRow>;

export const IntakeDraft = Type.Object({
  sourceKind: Type.Union([
    Type.Literal('customer_order'),
    Type.Literal('portal_pendency'),
    Type.Literal('other'),
  ]),
  detectedAs: Type.String(),
  summary: Type.String(),
  moves: Type.Array(DraftMove),
  pendency: Type.Array(PendencyRow),
  /** What the manager still has to answer, in plain words. */
  questions: Type.Array(Type.String()),
  notes: Type.String(),
});
export type IntakeDraft = Static<typeof IntakeDraft>;

/** A move as the manager confirms it on the review screen. */
export const ConfirmedMove = Type.Object({
  clientId: Type.String({ format: 'uuid' }),
  jobTypeId: Type.String({ format: 'uuid' }),
  cargoTypeId: Type.String({ format: 'uuid' }),
  fromLocationId: Type.String({ format: 'uuid' }),
  toLocationId: Type.String({ format: 'uuid' }),
  containerNumber: Type.Optional(Type.String()),
  readyAt: Type.Optional(Type.String()),
  cutoffAt: Type.Optional(Type.String()),
});
export type ConfirmedMove = Static<typeof ConfirmedMove>;

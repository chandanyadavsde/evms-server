import { type Static, Type } from '@sinclair/typebox';
import { Expression, Key, LocalizedText } from './common';

/**
 * Flow definition: the configurable workflow a Leg runs.
 * Stored as versioned JSON (config_definitions, kind = 'workflow') and resolved
 * through Platform -> Company -> Region -> Client -> Job type.
 */

export const FieldType = Type.Union([
  Type.Literal('text'),
  Type.Literal('number'),
  Type.Literal('date'),
  Type.Literal('select'),
  Type.Literal('photo'),
  Type.Literal('document'),
  Type.Literal('signature'),
]);
export type FieldType = Static<typeof FieldType>;

export const AiOptions = Type.Object(
  {
    /** Extract structured fields from a document using its doc type's template. */
    extract: Type.Optional(Type.Boolean()),
    /** Read a single value from a photo. */
    read: Type.Optional(Type.Union([Type.Literal('odometer'), Type.Literal('soc')])),
    /** Named cross-check, e.g. "match_with_lr". */
    check: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const FieldDef = Type.Object(
  {
    key: Key,
    type: FieldType,
    label: LocalizedText,
    required: Type.Optional(Type.Boolean()),
    /** For type = document: which document type (configured in the document library). */
    docType: Type.Optional(Type.String()),
    /** For type = select. */
    options: Type.Optional(Type.Array(Type.Object({ value: Type.String(), label: LocalizedText }))),
    ai: Type.Optional(AiOptions),
    /** Validation rule; evaluated with { value, context }. Must return true. */
    rule: Type.Optional(Expression),
    ruleMessage: Type.Optional(LocalizedText),
    /** Built-in check by name, e.g. "container_number" (ISO 6346 check digit). */
    validate: Type.Optional(Type.Literal('container_number')),
    /** Writes the value into the live world model, e.g. the vehicle's odometer. */
    bind: Type.Optional(
      Type.Union([Type.Literal('vehicle.odometer'), Type.Literal('vehicle.soc')]),
    ),
  },
  { additionalProperties: false },
);
export type FieldDef = Static<typeof FieldDef>;

export const ConditionalRequirement = Type.Object(
  {
    /** Evaluated against the step context (cargo, client, leg, fields). */
    if: Expression,
    /** Field keys that become required when the condition is true. */
    require: Type.Array(Key),
  },
  { additionalProperties: false },
);

export const Automation = Type.Object(
  {
    type: Type.Union([
      Type.Literal('notify'),
      Type.Literal('lr.create_pre_lr'),
      Type.Literal('lr.issue'),
      Type.Literal('lr.close'),
      Type.Literal('hook'),
    ]),
    /** notify: role to notify; hook: named backend function. */
    target: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const Transition = Type.Object(
  {
    action: Key,
    label: LocalizedText,
    /** Next step key, or "end" to finish the leg. */
    to: Type.String(),
    style: Type.Optional(Type.Union([Type.Literal('primary'), Type.Literal('secondary')])),
    /** Skip mandatory-field checks (e.g. "report_issue"). */
    skipValidation: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const StepDef = Type.Object(
  {
    key: Key,
    title: LocalizedText,
    actor: Type.Union([Type.Literal('driver'), Type.Literal('manager')]),
    fields: Type.Array(FieldDef),
    conditions: Type.Optional(Type.Array(ConditionalRequirement)),
    geoCheck: Type.Optional(
      Type.Object(
        {
          location: Type.Union([Type.Literal('from'), Type.Literal('to')]),
          radiusM: Type.Integer({ minimum: 50 }),
        },
        { additionalProperties: false },
      ),
    ),
    transitions: Type.Array(Transition, { minItems: 1 }),
    onEnter: Type.Optional(Type.Array(Automation)),
    onComplete: Type.Optional(Type.Array(Automation)),
    sla: Type.Optional(
      Type.Object({ maxMinutes: Type.Integer({ minimum: 1 }), alert: Type.String() }),
    ),
  },
  { additionalProperties: false },
);
export type StepDef = Static<typeof StepDef>;

export const FlowDefinition = Type.Object(
  {
    key: Key,
    name: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    initialStep: Key,
    steps: Type.Array(StepDef, { minItems: 1 }),
  },
  { $id: 'FlowDefinition', additionalProperties: false },
);
export type FlowDefinition = Static<typeof FlowDefinition>;

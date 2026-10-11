import { type Static, Type } from '@sinclair/typebox';

/**
 * Screen contract: what the backend sends and React / Flutter render.
 * Frontends only know these component types; all business rules stay in the backend.
 * Labels arrive already resolved to the user's language.
 */

const base = {
  key: Type.String(),
  label: Type.String(),
  required: Type.Boolean(),
  value: Type.Optional(Type.Unknown()),
};

export const InfoCard = Type.Object({
  type: Type.Literal('info_card'),
  data: Type.Record(Type.String(), Type.String()),
});

export const TextInput = Type.Object({ type: Type.Literal('text'), ...base });
export const NumberInput = Type.Object({ type: Type.Literal('number'), ...base });
export const DateInput = Type.Object({ type: Type.Literal('date'), ...base });
export const SelectInput = Type.Object({
  type: Type.Literal('select'),
  ...base,
  options: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })),
});
export const PhotoInput = Type.Object({
  type: Type.Literal('photo'),
  ...base,
  aiRead: Type.Optional(Type.String()),
});
export const DocumentInput = Type.Object({
  type: Type.Literal('document'),
  ...base,
  docType: Type.Optional(Type.String()),
  aiExtract: Type.Optional(Type.Boolean()),
});
export const SignatureInput = Type.Object({ type: Type.Literal('signature'), ...base });

export const Component = Type.Union(
  [
    InfoCard,
    TextInput,
    NumberInput,
    DateInput,
    SelectInput,
    PhotoInput,
    DocumentInput,
    SignatureInput,
  ],
  { $id: 'Component' },
);
export type Component = Static<typeof Component>;

export const ScreenAction = Type.Object({
  id: Type.String(),
  label: Type.String(),
  style: Type.Union([Type.Literal('primary'), Type.Literal('secondary')]),
});
export type ScreenAction = Static<typeof ScreenAction>;

export const Screen = Type.Object(
  {
    contractVersion: Type.Literal(1),
    step: Type.String(),
    title: Type.String(),
    components: Type.Array(Component),
    actions: Type.Array(ScreenAction),
    geoCheck: Type.Optional(
      Type.Object({ lat: Type.Number(), lng: Type.Number(), radiusM: Type.Integer() }),
    ),
  },
  { $id: 'Screen' },
);
export type Screen = Static<typeof Screen>;

/** Component types supported by contract v1. Apps reject screens with unknown types. */
export const COMPONENT_TYPES_V1 = [
  'info_card',
  'text',
  'number',
  'date',
  'select',
  'photo',
  'document',
  'signature',
] as const;

import { type Static, Type } from '@sinclair/typebox';

/** A label shown to users: plain text, or text per language code ("en", "hi", "mr"...). */
export const LocalizedText = Type.Union(
  [Type.String(), Type.Record(Type.String(), Type.String())],
  {
    $id: 'LocalizedText',
  },
);
export type LocalizedText = Static<typeof LocalizedText>;

/** A JSONLogic expression (https://jsonlogic.com). Kept opaque here; evaluated by the backend. */
export const Expression = Type.Unknown({ $id: 'Expression' });
export type Expression = Static<typeof Expression>;

export const Key = Type.String({ pattern: '^[a-z][a-z0-9_]*$', maxLength: 64 });

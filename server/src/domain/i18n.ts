import type { LocalizedText } from '@vms/contracts';

/** Picks the user's language, then English, then whatever exists. */
export function localize(text: LocalizedText, lang: string): string {
  if (typeof text === 'string') return text;
  return text[lang] ?? text.en ?? Object.values(text)[0] ?? '';
}

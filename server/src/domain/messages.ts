/**
 * System messages shown to drivers/managers, per language. Flow labels live in config;
 * these are the engine's own words. Add a language by adding a column.
 */
const MESSAGES = {
  required: { en: 'Required', hi: 'ज़रूरी है' },
  mustBeNumber: { en: 'Must be a number', hi: 'संख्या होनी चाहिए' },
  invalidContainer: {
    en: 'Not a valid container number (check digit)',
    hi: 'कंटेनर नंबर सही नहीं है (चेक डिजिट)',
  },
  invalidValue: { en: 'Invalid value', hi: 'मान सही नहीं है' },
  fixFields: { en: 'Please fix the highlighted fields', hi: 'कृपया लाल रंग वाले फ़ील्ड ठीक करें' },
  actionNotAllowed: { en: 'This action is not allowed now', hi: 'यह काम अभी नहीं किया जा सकता' },
  legNotActive: { en: 'This leg is not active', hi: 'यह यात्रा अभी चालू नहीं है' },
  otherDriver: {
    en: 'This leg is assigned to another driver',
    hi: 'यह यात्रा किसी दूसरे ड्राइवर की है',
  },
  managerStep: { en: 'This step is for a manager', hi: 'यह काम मैनेजर का है' },
  invalidFile: { en: 'Upload the file again', hi: 'फ़ाइल फिर से अपलोड करें' },
} as const;

export type MessageKey = keyof typeof MESSAGES;

export function msg(key: MessageKey, lang: string): string {
  const m: Record<string, string> = MESSAGES[key];
  return m[lang] ?? m.en ?? key;
}

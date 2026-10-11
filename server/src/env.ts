import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvSchema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    { default: 'development' },
  ),
  PORT: Type.Number({ default: 4100 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  /** postgres://… or pglite:<folder> or pglite:memory (see db/client.ts). */
  DATABASE_URL: Type.String({ default: 'pglite:./.data/pg' }),
  JWT_SECRET: Type.String({ default: 'dev-only-secret-change-me' }),
  /** Folder for uploaded evidence until S3/MinIO is wired in. */
  FILES_DIR: Type.String({ default: './.data/files' }),
  /** Fixed OTP for local development (no SMS/email provider yet). Empty = random codes. */
  DEV_OTP: Type.String({ default: '123456' }),
  /** Where flow JSON files live; loaded into config_definitions by the seed. */
  FLOWS_DIR: Type.String({ default: '../config/flows' }),
  RATE_CARDS_DIR: Type.String({ default: '../config/rate-cards' }),
  TEMPLATES_DIR: Type.String({ default: '../config/extraction-templates' }),
  /**
   * How documents, screenshots and messages are read:
   *   ocr    – free local Tesseract OCR + rules (default, no key needed)
   *   gemini – Google Gemini vision model (needs GEMINI_API_KEY; free key = test data only)
   *   openrouter – any vision model via OpenRouter (needs OPENROUTER_API_KEY; OPENROUTER_MODEL)
   *   claude – Claude vision model (needs ANTHROPIC_API_KEY or an "ant auth login" profile)
   *   off    – no reading of images; typed/pasted text still goes through the rules
   */
  AI_MODE: Type.Union(
    [
      Type.Literal('off'),
      Type.Literal('ocr'),
      Type.Literal('gemini'),
      Type.Literal('openrouter'),
      Type.Literal('claude'),
    ],
    { default: 'ocr' },
  ),
  /** Claude model used when AI_MODE=claude. */
  AI_MODEL: Type.String({ default: 'claude-opus-5-5' }),
  GEMINI_API_KEY: Type.Optional(Type.String()),
  OPENROUTER_API_KEY: Type.Optional(Type.String()),
  /** Cheapest reliable vision model with JSON output (about $0.10 / $0.40 per million tokens). */
  OPENROUTER_MODEL: Type.String({ default: 'google/gemini-2.5-flash-lite' }),
  /** Gemini model used when AI_MODE=gemini. The "-latest" alias follows Google's current Flash. */
  GEMINI_MODEL: Type.String({ default: 'gemini-flash-latest' }),
  /** Set to "paid" once the Gemini key is on a paid plan; until then the UI warns: test data only. */
  GEMINI_TIER: Type.Union([Type.Literal('free'), Type.Literal('paid')], { default: 'free' }),
  /** off | mock (development) | restlet (real NetSuite, see modules/billing/netsuite.ts). */
  NETSUITE_MODE: Type.Union([Type.Literal('off'), Type.Literal('mock'), Type.Literal('restlet')], {
    default: 'mock',
  }),
  NETSUITE_ACCOUNT: Type.Optional(Type.String()),
  NETSUITE_RESTLET_URL: Type.Optional(Type.String()),
  NETSUITE_CONSUMER_KEY: Type.Optional(Type.String()),
  NETSUITE_CONSUMER_SECRET: Type.Optional(Type.String()),
  NETSUITE_TOKEN_ID: Type.Optional(Type.String()),
  NETSUITE_TOKEN_SECRET: Type.Optional(Type.String()),
});
export type Env = Static<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const raw = Value.Default(EnvSchema, Value.Convert(EnvSchema, { ...source }));
  const cleaned = Value.Clean(EnvSchema, raw);
  if (!Value.Check(EnvSchema, cleaned)) {
    const first = [...Value.Errors(EnvSchema, cleaned)][0];
    throw new Error(`Invalid environment: ${first?.path} ${first?.message}`);
  }
  if (cleaned.NODE_ENV === 'production' && cleaned.JWT_SECRET.startsWith('dev-only')) {
    throw new Error('Set JWT_SECRET in production');
  }
  if (cleaned.NODE_ENV === 'production' && cleaned.NETSUITE_MODE === 'mock') {
    throw new Error('NETSUITE_MODE=mock is for development only');
  }
  if (cleaned.AI_MODE === 'gemini' && !cleaned.GEMINI_API_KEY) {
    throw new Error('AI_MODE=gemini needs GEMINI_API_KEY (free key: https://aistudio.google.com)');
  }
  if (cleaned.AI_MODE === 'openrouter' && !cleaned.OPENROUTER_API_KEY) {
    throw new Error('AI_MODE=openrouter needs OPENROUTER_API_KEY');
  }
  if (cleaned.NODE_ENV === 'production' && cleaned.DEV_OTP) {
    throw new Error('DEV_OTP must be empty in production');
  }
  return cleaned;
}

export function netSuiteConfig(env: Env) {
  return {
    mode: env.NETSUITE_MODE,
    ...(env.NETSUITE_ACCOUNT ? { account: env.NETSUITE_ACCOUNT } : {}),
    ...(env.NETSUITE_RESTLET_URL ? { restletUrl: env.NETSUITE_RESTLET_URL } : {}),
    ...(env.NETSUITE_CONSUMER_KEY ? { consumerKey: env.NETSUITE_CONSUMER_KEY } : {}),
    ...(env.NETSUITE_CONSUMER_SECRET ? { consumerSecret: env.NETSUITE_CONSUMER_SECRET } : {}),
    ...(env.NETSUITE_TOKEN_ID ? { tokenId: env.NETSUITE_TOKEN_ID } : {}),
    ...(env.NETSUITE_TOKEN_SECRET ? { tokenSecret: env.NETSUITE_TOKEN_SECRET } : {}),
  };
}

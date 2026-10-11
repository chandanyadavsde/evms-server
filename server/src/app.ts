import { join } from 'node:path';
import cors from '@fastify/cors';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import type { Db } from './db/client';
import { type Env, netSuiteConfig } from './env';
import { registerErrorHandler } from './lib/errors';
import { adminRoutes } from './modules/admin/routes';
import { setupRoutes } from './modules/admin/setup-routes';
import { type Extractor, LlmExtractor } from './modules/ai/extractor';
import { ClaudeModel, GeminiModel, OpenRouterModel, type VisionModel } from './modules/ai/llm';
import { OcrExtractor } from './modules/ai/ocr';
import { aiRoutes } from './modules/ai/routes';
import { assistRoutes } from './modules/assist/routes';
import { authRoutes } from './modules/auth/routes';
import { billingRoutes } from './modules/billing/routes';
import { configRoutes } from './modules/config/routes';
import { dispatchRoutes } from './modules/dispatch/routes';
import { exceptionRoutes } from './modules/exceptions/routes';
import { filesRoutes } from './modules/files/routes';
import { healthRoutes } from './modules/health/routes';
import { type IntakeReader, LlmIntakeReader } from './modules/intake/reader';
import { intakeRoutes } from './modules/intake/routes';
import { RuleIntakeReader } from './modules/intake/rules';
import { masterRoutes } from './modules/master/routes';
import { operationsRoutes } from './modules/operations/routes';
import { authPlugin } from './plugins/auth';
import { dbPlugin } from './plugins/db';

/** Builds the Fastify app. Each module is an encapsulated plugin. */
export async function buildApp(
  env: Env,
  db: Db,
  opts: {
    extractor?: Extractor | null;
    intakeReader?: IntakeReader;
    /** Override the vision model (tests pass a fake; null = rules only). */
    model?: VisionModel | null;
  } = {},
) {
  const model = opts.model !== undefined ? opts.model : createVisionModel(env);
  const extractor = opts.extractor !== undefined ? opts.extractor : createExtractor(env, model);
  const intakeReader = opts.intakeReader ?? createIntakeReader(model, extractor);
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
  }).withTypeProvider<TypeBoxTypeProvider>();

  registerErrorHandler(app);
  await app.register(cors, { origin: true });
  await app.register(dbPlugin, { db });
  await app.register(authPlugin, { secret: env.JWT_SECRET });

  await app.register(healthRoutes);
  await app.register(authRoutes, { devOtp: env.DEV_OTP });
  await app.register(masterRoutes);
  await app.register(operationsRoutes);
  await app.register(filesRoutes, { dir: env.FILES_DIR });
  await app.register(adminRoutes);
  await app.register(setupRoutes);
  await app.register(configRoutes);
  await app.register(exceptionRoutes);
  await app.register(billingRoutes, { netsuite: netSuiteConfig(env) });
  await app.register(aiRoutes, { extractor, filesDir: env.FILES_DIR });
  await app.register(dispatchRoutes);
  await app.register(assistRoutes, { model });
  await app.register(intakeRoutes, {
    reader: intakeReader,
    filesDir: env.FILES_DIR,
    // Free models may log or train on inputs: warn to use test data only.
    testDataOnly:
      (env.AI_MODE === 'gemini' && env.GEMINI_TIER === 'free') ||
      (env.AI_MODE === 'openrouter' && env.OPENROUTER_MODEL.endsWith(':free')),
  });
  app.decorate('extractor', extractor);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    extractor: Extractor | null;
  }
}

/** The vision model for AI_MODE=claude|gemini; null for ocr/off. Keys stay on the server. */
export function createVisionModel(env: Env): VisionModel | null {
  if (env.AI_MODE === 'claude') return new ClaudeModel(env.AI_MODEL);
  if (env.AI_MODE === 'gemini' && env.GEMINI_API_KEY)
    return new GeminiModel(env.GEMINI_MODEL, env.GEMINI_API_KEY);
  if (env.AI_MODE === 'openrouter' && env.OPENROUTER_API_KEY)
    return new OpenRouterModel(env.OPENROUTER_MODEL, env.OPENROUTER_API_KEY);
  return null;
}

export function createExtractor(env: Env, model = createVisionModel(env)): Extractor | null {
  if (model) return new LlmExtractor(model);
  if (env.AI_MODE === 'ocr') return new OcrExtractor(join(env.FILES_DIR, '..', 'ocr-cache'));
  return null;
}

/** Smart intake reasons with the vision model when there is one; otherwise free rules (+ OCR). */
export function createIntakeReader(
  model: VisionModel | null,
  extractor: Extractor | null,
): IntakeReader {
  if (model) return new LlmIntakeReader(model);
  return new RuleIntakeReader(extractor instanceof OcrExtractor ? extractor : null);
}

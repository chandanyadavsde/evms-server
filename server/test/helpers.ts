import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { migrateToLatest } from '../src/db/migrate';
import { seed } from '../src/db/seed';
import { loadEnv } from '../src/env';
import type { Extractor } from '../src/modules/ai/extractor';
import type { VisionModel } from '../src/modules/ai/llm';
import type { IntakeReader } from '../src/modules/intake/reader';

export const FLOWS_DIR = join(import.meta.dirname, '..', '..', 'config', 'flows');

/** Fresh app on an in-memory Postgres (PGlite), migrated and seeded. */
export async function makeTestApp(
  opts: {
    extractor?: Extractor | null;
    intakeReader?: IntakeReader;
    model?: VisionModel | null;
  } = {},
) {
  const filesDir = mkdtempSync(join(tmpdir(), 'vms-files-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    DEV_OTP: '123456',
    FLOWS_DIR,
    FILES_DIR: filesDir,
    AI_MODE: 'off',
  });
  const db = createDb(env.DATABASE_URL);
  await migrateToLatest(db);
  await seed(db, FLOWS_DIR);
  const app = await buildApp(env, db, {
    extractor: opts.extractor ?? null,
    ...(opts.intakeReader ? { intakeReader: opts.intakeReader } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });

  async function login(identifier: string): Promise<string> {
    await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { identifier } });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { identifier, code: '123456' },
    });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
    return res.json().token;
  }

  function call(token: string) {
    const headers = { authorization: `Bearer ${token}` };
    return {
      get: (url: string) => app.inject({ method: 'GET', url, headers }),
      post: (url: string, payload: unknown) =>
        app.inject({ method: 'POST', url, headers, payload: payload as object }),
    };
  }

  /** Uploads a small PNG and returns its storage key. */
  async function upload(token: string, name = 'photo.png'): Promise<string> {
    const boundary = '----vmstest';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/files',
      payload: body,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
    if (res.statusCode !== 201) throw new Error(`upload failed: ${res.body}`);
    return res.json().key;
  }

  return { app, db, login, call, upload, filesDir };
}

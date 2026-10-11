import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { badRequest, forbidden, notFound } from '../../lib/errors';

const ALLOWED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.heic']);
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
};

/**
 * Evidence files on local disk until S3/MinIO is wired in. Keys look like "<tenantId>/<uuid>.jpg";
 * the tenant prefix is checked on every read.
 */
export const filesRoutes: FastifyPluginAsyncTypebox<{ dir: string }> = async (app, opts) => {
  const root = resolve(opts.dir);
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

  app.post('/v1/files', { preHandler: app.auth() }, async (req, reply) => {
    const file = await req.file();
    if (!file) throw badRequest('No file uploaded');
    const ext = extname(file.filename).toLowerCase() || '.jpg';
    if (!ALLOWED.has(ext)) throw badRequest(`File type ${ext} not allowed`);
    const dir = join(root, req.user.tid);
    mkdirSync(dir, { recursive: true });
    const key = `${req.user.tid}/${randomUUID()}${ext}`;
    await writeFile(join(root, key), await file.toBuffer());
    return reply.code(201).send({ key });
  });

  app.get(
    '/v1/files/:tenant/:name',
    {
      preHandler: app.auth(),
      schema: {
        params: Type.Object({
          tenant: Type.String(),
          name: Type.String({ pattern: '^[0-9a-f-]{36}\\.[a-z]{3,4}$' }),
        }),
      },
    },
    async (req, reply) => {
      if (req.params.tenant !== req.user.tid) throw forbidden();
      const path = join(root, req.params.tenant, req.params.name);
      if (!existsSync(path)) throw notFound('File');
      return reply
        .type(MIME[extname(path)] ?? 'application/octet-stream')
        .send(createReadStream(path));
    },
  );
};

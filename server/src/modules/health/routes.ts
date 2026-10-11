import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { sql } from 'kysely';

export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get('/health', async () => ({ status: 'ok' as const }));

  app.get('/health/db', async (_req, reply) => {
    try {
      await sql`select 1`.execute(app.db);
      return { status: 'ok' as const };
    } catch (err) {
      return reply.code(503).send({ status: 'down', error: (err as Error).message });
    }
  });
};

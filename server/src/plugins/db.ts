import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Db } from '../db/client';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

/** Registers the shared Kysely instance as `app.db` and closes it on shutdown. */
export const dbPlugin = fp(async (app: FastifyInstance, opts: { db: Db }) => {
  app.decorate('db', opts.db);
  app.addHook('onClose', async () => opts.db.destroy());
});

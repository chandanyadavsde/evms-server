import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, forbidden } from '../lib/errors';

export type RoleCode = 'admin' | 'manager' | 'driver';

export interface AuthUser {
  sub: string; // user id
  tid: string; // tenant id
  roles: RoleCode[];
  lang: string;
  driverId?: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler: requires a valid token; optionally one of the given roles. */
    auth: (...roles: RoleCode[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const authPlugin = fp(async (app, opts: { secret: string }) => {
  await app.register(jwt, { secret: opts.secret, sign: { expiresIn: '12h' } });

  app.decorate('auth', (...roles: RoleCode[]) => async (req: FastifyRequest) => {
    try {
      // Files are opened by <img src>, which can't send headers, so a ?token= is accepted too.
      const queryToken = (req.query as { token?: string } | undefined)?.token;
      if (queryToken && !req.headers.authorization) {
        req.user = app.jwt.verify<AuthUser>(queryToken);
      } else {
        await req.jwtVerify();
      }
    } catch {
      throw new AppError(401, 'Not signed in');
    }
    if (roles.length && !roles.some((r) => req.user.roles.includes(r))) throw forbidden();
  });
});

export const isStaff = (u: AuthUser) => u.roles.includes('admin') || u.roles.includes('manager');

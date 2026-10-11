import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { AppError, badRequest } from '../../lib/errors';
import type { AuthUser, RoleCode } from '../../plugins/auth';

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const hash = (code: string) => createHash('sha256').update(code).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Email (managers/admins) or phone (drivers) → normalized lookup key. */
function parseIdentifier(raw: string): { email?: string; phone?: string } {
  const v = raw.trim().toLowerCase();
  if (v.includes('@')) return { email: v };
  const digits = v.replace(/\D/g, '');
  if (digits.length >= 10) return { phone: digits.slice(-10) };
  throw badRequest('Enter a work email or a 10-digit phone number');
}

export const authRoutes: FastifyPluginAsyncTypebox<{ devOtp: string }> = async (app, opts) => {
  const db = app.db;

  async function findUser(identifier: string) {
    const { email, phone } = parseIdentifier(identifier);
    const q = db.selectFrom('users').selectAll().where('active', '=', true);
    return email
      ? q.where('email', '=', email).executeTakeFirst()
      : q.where('phone', '=', phone ?? '').executeTakeFirst();
  }

  app.post(
    '/v1/auth/otp/request',
    { schema: { body: Type.Object({ identifier: Type.String({ minLength: 3 }) }) } },
    async (req) => {
      const user = await findUser(req.body.identifier);
      // Same answer whether or not the user exists, so the endpoint can't be used to probe accounts.
      if (!user) return { sent: true };

      const code = opts.devOtp || String(randomInt(0, 1_000_000)).padStart(6, '0');
      await db
        .insertInto('otp_codes')
        .values({
          user_id: user.id,
          code_hash: hash(code),
          expires_at: new Date(Date.now() + OTP_TTL_MS),
        })
        .execute();
      // TODO(phase 1): send by email / SMS. Until then the code is in the server log.
      req.log.info({ userId: user.id }, `OTP for ${req.body.identifier}: ${code}`);
      return {
        sent: true,
        ...(opts.devOtp ? { devHint: 'Development mode: use the fixed code' } : {}),
      };
    },
  );

  app.post(
    '/v1/auth/otp/verify',
    {
      schema: {
        body: Type.Object({
          identifier: Type.String(),
          code: Type.String({ pattern: '^\\d{6}$' }),
        }),
      },
    },
    async (req) => {
      const user = await findUser(req.body.identifier);
      const invalid = new AppError(401, "That code didn't match. Request a new one and try again.");
      if (!user) throw invalid;

      const otp = await db
        .selectFrom('otp_codes')
        .selectAll()
        .where('user_id', '=', user.id)
        .where('consumed_at', 'is', null)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (!otp || otp.expires_at.getTime() < Date.now() || otp.attempts >= MAX_ATTEMPTS) {
        throw new AppError(401, 'This code has expired. Request a new one.');
      }
      if (!sameHash(otp.code_hash, hash(req.body.code))) {
        await db
          .updateTable('otp_codes')
          .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
          .where('id', '=', otp.id)
          .execute();
        throw invalid;
      }
      await db
        .updateTable('otp_codes')
        .set({ consumed_at: new Date() })
        .where('id', '=', otp.id)
        .execute();

      const roles = (
        await db
          .selectFrom('user_roles')
          .innerJoin('roles', 'roles.id', 'user_roles.role_id')
          .select('roles.code')
          .where('user_roles.user_id', '=', user.id)
          .execute()
      ).map((r) => r.code as RoleCode);
      const driver = await db
        .selectFrom('drivers')
        .select('id')
        .where('user_id', '=', user.id)
        .executeTakeFirst();

      const payload: AuthUser = {
        sub: user.id,
        tid: user.tenant_id,
        roles,
        lang: user.language,
        ...(driver ? { driverId: driver.id } : {}),
      };
      return {
        token: app.jwt.sign(payload),
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          roles,
          language: user.language,
        },
      };
    },
  );

  app.get('/v1/me', { preHandler: app.auth() }, async (req) => {
    const user = await db
      .selectFrom('users')
      .select(['id', 'name', 'email', 'phone', 'language'])
      .where('id', '=', req.user.sub)
      .executeTakeFirstOrThrow();
    return { ...user, roles: req.user.roles, driverId: req.user.driverId ?? null };
  });
};

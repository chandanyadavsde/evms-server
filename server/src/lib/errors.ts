import type { FastifyError, FastifyInstance } from 'fastify';

/** Error with an HTTP status and optional field errors; rendered as { error, details }. */
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, message, details);
export const forbidden = (message = 'Not allowed') => new AppError(403, message);

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: err.message, details: err.details });
    }
    const fe = err as FastifyError;
    if (fe.validation) {
      // Field-level reasons the UI can show next to the field, e.g. {field: "cutoffAt", message: …}.
      const details = fe.validation.map((v) => {
        const missing = (v.params as { missingProperty?: string }).missingProperty;
        const field = missing ?? v.instancePath.replace(/^\//, '').replace(/\//g, '.') ?? '';
        return {
          field: field || '_request',
          message: missing ? 'Required' : (v.message ?? 'Invalid value'),
        };
      });
      req.log.warn({ url: req.url, details }, 'request rejected by validation');
      const summary = details.map((d) => `${d.field}: ${d.message}`).join('; ');
      return reply.code(400).send({ error: `Invalid request — ${summary}`, details });
    }
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: fe.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'Internal error' });
  });
}

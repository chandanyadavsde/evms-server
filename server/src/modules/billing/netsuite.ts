import { createHmac, randomBytes } from 'node:crypto';
import type { Db } from '../../db/client';
import { recordEvent } from '../../lib/db-utils';

/**
 * NetSuite connector. Modes:
 *   off     – nothing is sent; LRs wait in the outbox.
 *   mock    – development: marks items sent with a "MOCK-" reference (clearly not a real invoice).
 *   restlet – POSTs the payload to a RESTlet your NetSuite admin deploys, signed with
 *             Token-Based Authentication (OAuth 1.0, HMAC-SHA256).
 * NOT YET VERIFIED against a real NetSuite account — test in a NetSuite sandbox first.
 */
export interface NetSuiteConfig {
  mode: 'off' | 'mock' | 'restlet';
  account?: string; // e.g. 1234567 or 1234567_SB1
  restletUrl?: string;
  consumerKey?: string;
  consumerSecret?: string;
  tokenId?: string;
  tokenSecret?: string;
}

const enc = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** OAuth 1.0 header for NetSuite TBA. Query parameters of the URL are part of the signature. */
export function oauthHeader(
  cfg: Required<Omit<NetSuiteConfig, 'mode'>>,
  method: string,
  url: string,
  nonce = randomBytes(16).toString('hex'),
  ts = Math.floor(Date.now() / 1000),
): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: cfg.consumerKey,
    oauth_token: cfg.tokenId,
    oauth_nonce: nonce,
    oauth_timestamp: String(ts),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_version: '1.0',
  };
  const params = [...u.searchParams.entries(), ...Object.entries(oauth)]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const base = [method.toUpperCase(), enc(baseUrl), enc(params)].join('&');
  const signature = createHmac('sha256', `${enc(cfg.consumerSecret)}&${enc(cfg.tokenSecret)}`)
    .update(base)
    .digest('base64');
  const fields = {
    realm: cfg.account.toUpperCase().replace('-', '_'),
    ...oauth,
    oauth_signature: signature,
  };
  return `OAuth ${Object.entries(fields)
    .map(([k, v]) => `${k}="${enc(v)}"`)
    .join(', ')}`;
}

async function send(cfg: NetSuiteConfig, payload: unknown): Promise<string> {
  if (cfg.mode === 'mock') return `MOCK-INV-${Date.now().toString(36).toUpperCase()}`;
  if (cfg.mode !== 'restlet') throw new Error('NetSuite sending is off');
  const { account, restletUrl, consumerKey, consumerSecret, tokenId, tokenSecret } = cfg;
  if (!account || !restletUrl || !consumerKey || !consumerSecret || !tokenId || !tokenSecret) {
    throw new Error('NetSuite credentials are incomplete');
  }
  const res = await fetch(restletUrl, {
    method: 'POST',
    headers: {
      authorization: oauthHeader(
        { account, restletUrl, consumerKey, consumerSecret, tokenId, tokenSecret },
        'POST',
        restletUrl,
      ),
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`NetSuite ${res.status}: ${text.slice(0, 300)}`);
  // The RESTlet is expected to return {"id": "<internal id or invoice number>"}.
  try {
    return String(JSON.parse(text).id ?? text);
  } catch {
    return text.slice(0, 100);
  }
}

const MAX_ATTEMPTS = 8;

/** Sends pending outbox items. Safe to run repeatedly; each LR is sent at most once successfully. */
export async function processOutbox(
  db: Db,
  cfg: NetSuiteConfig,
  onlyId?: string,
): Promise<{ sent: number; failed: number }> {
  let q = db
    .selectFrom('integration_outbox')
    .selectAll()
    .where('target', '=', 'netsuite')
    .where('status', '!=', 'sent');
  q = onlyId ? q.where('id', '=', onlyId) : q.where('attempts', '<', MAX_ATTEMPTS);
  const items = await q.orderBy('created_at').limit(50).execute();
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const ref = await send(cfg, item.payload);
      await db
        .updateTable('integration_outbox')
        .set({
          status: 'sent',
          sent_at: new Date(),
          external_ref: ref,
          last_error: null,
          attempts: item.attempts + 1,
        })
        .where('id', '=', item.id)
        .execute();
      if (item.entity === 'lr') {
        await db
          .updateTable('lrs')
          .set({ status: 'pushed', netsuite_ref: ref, pushed_at: new Date() })
          .where('id', '=', item.entity_id)
          .execute();
        await recordEvent(db, {
          tenantId: item.tenant_id,
          entity: 'lr',
          entityId: item.entity_id,
          type: 'lr.pushed',
          payload: { ref, mode: cfg.mode },
        });
      }
      sent++;
    } catch (err) {
      await db
        .updateTable('integration_outbox')
        .set({
          status: 'failed',
          attempts: item.attempts + 1,
          last_error: (err as Error).message.slice(0, 500),
        })
        .where('id', '=', item.id)
        .execute();
      failed++;
    }
  }
  return { sent, failed };
}

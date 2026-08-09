/**
 * Physical mail provider adapter (Lob-or-generic) with sink implementation.
 *
 * Product path states (record.mail_provider_status / mail_last_*):
 *   allocated  — campaign mail_allocated=true (completeManualTask / allocateMail)
 *   submitted  — piece accepted by provider (piece_id set)
 *   confirmed  — provider confirmed print/mail or delivery event
 *   failed     — provider rejected / permanent failure
 *
 * Live Lob credentials are canary-owned. Production tests use the sink
 * (AO_MAIL_SINK=1 or createMailProviderSink).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '../lib/record.js';
import { deliveryModeForChannel } from '../runtime/delivery-mode.js';

export type MailProviderStatus = 'allocated' | 'submitted' | 'confirmed' | 'failed' | 'uncertain';

export type MailSubmitRequest = {
  recordId: string;
  treatment: string;
  to: {
    name?: string;
    address_line_1?: string;
    address_city?: string;
    address_state?: string;
    address_zip?: string;
  };
  from?: Record<string, string>;
  template_id?: string;
  /** Pipeline-declared commercial cost; providers never infer it from a product name. */
  expected_cost_cents?: number;
  merge_variables?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

export type MailSubmitResult = {
  ok: boolean;
  piece_id: string;
  status: MailProviderStatus;
  reason: string;
  cost_cents?: number;
  expected_delivery_date?: string;
  provider: string;
  /** POST response was not observed, so provider acceptance cannot be disproved. */
  outcome_unknown?: boolean;
  raw?: Record<string, unknown>;
};

export type MailStatusResult = {
  piece_id: string;
  status: MailProviderStatus | 'in_transit' | 'delivered' | 'returned' | 'unknown';
  reason: string;
  delivered_at?: string;
  returned_at?: string;
  provider: string;
  raw?: Record<string, unknown>;
};

export type MailProvider = {
  name: string;
  submit(req: MailSubmitRequest): Promise<MailSubmitResult>;
  getStatus(pieceId: string): Promise<MailStatusResult>;
};

const text = (value: unknown) => String(value ?? '').trim();

/** Parse durable provider status from a record. */
export function parseMailProviderStatus(
  record: Record<string, unknown> | null | undefined,
): MailProviderStatus | '' {
  const explicit = text(record?.mail_provider_status).toLowerCase();
  if (
    explicit === 'allocated'
    || explicit === 'submitted'
    || explicit === 'confirmed'
    || explicit === 'failed'
  ) {
    return explicit;
  }
  if (text(record?.mail_last_piece_id)) {
    if (text(record?.mail_last_delivered_at)) return 'confirmed';
    if (text(record?.mail_last_failed_at) || text(record?.mail_last_returned_at)) return 'failed';
    return 'submitted';
  }
  if (
    record?.mail_allocated === 1
    || record?.mail_allocated === true
    || record?.mail_allocated === '1'
  ) {
    return 'allocated';
  }
  return '';
}

export function applyMailAllocated(input: {
  record: Record<string, unknown>;
  at?: string;
}): { patch: Record<string, unknown>; status: MailProviderStatus } {
  const at = String(input.at || new Date().toISOString());
  return {
    status: 'allocated',
    patch: {
      ...input.record,
      mail_allocated: 1,
      mail_allocated_at: at,
      mail_provider_status: 'allocated',
    },
  };
}

export function applyMailSubmitted(input: {
  record: Record<string, unknown>;
  result: MailSubmitResult;
  at?: string;
}): { patch: Record<string, unknown>; status: MailProviderStatus } {
  const at = String(input.at || new Date().toISOString());
  const ok = input.result.ok && input.result.status !== 'failed';
  if (!ok) {
    return {
      status: 'failed',
      patch: {
        ...input.record,
        mail_provider_status: 'failed',
        mail_last_failed_at: at,
        mail_last_failure_reason: input.result.reason,
        mail_last_provider: input.result.provider,
      },
    };
  }
  return {
    status: 'submitted',
    patch: {
      ...input.record,
      mail_provider_status: 'submitted',
      mail_last_piece_id: input.result.piece_id,
      mail_last_submitted_at: at,
      mail_last_provider: input.result.provider,
      mail_last_cost_cents: Number(input.result.cost_cents || 0),
      mail_last_expected_delivery: String(input.result.expected_delivery_date || ''),
    },
  };
}

export function applyMailConfirmed(input: {
  record: Record<string, unknown>;
  statusResult: MailStatusResult;
  at?: string;
}): { patch: Record<string, unknown>; status: MailProviderStatus } {
  const at = String(input.at || new Date().toISOString());
  const st = String(input.statusResult.status || '').toLowerCase();
  if (st === 'failed' || st === 'returned') {
    return {
      status: 'failed',
      patch: {
        ...input.record,
        mail_provider_status: 'failed',
        mail_last_failed_at: at,
        mail_last_returned_at: input.statusResult.returned_at || at,
        mail_last_failure_reason: input.statusResult.reason,
      },
    };
  }
  if (st === 'confirmed' || st === 'delivered' || st === 'in_transit') {
    const confirmed = st === 'delivered' || st === 'confirmed';
    return {
      status: confirmed ? 'confirmed' : 'submitted',
      patch: {
        ...input.record,
        mail_provider_status: confirmed ? 'confirmed' : 'submitted',
        ...(confirmed
          ? { mail_last_delivered_at: input.statusResult.delivered_at || at }
          : {}),
        mail_last_provider: input.statusResult.provider,
      },
    };
  }
  return {
    status: parseMailProviderStatus(input.record) || 'submitted',
    patch: { ...input.record },
  };
}

/**
 * File-backed sink provider for $0 tests and local dry runs.
 * Writes JSON pieces under sinkDir; getStatus reads them back.
 */
export function createMailProviderSink(opts: {
  sinkDir: string;
  /** Force submit failure for tests. */
  failSubmit?: boolean;
  /** Status returned by getStatus (default confirmed). */
  confirmStatus?: MailStatusResult['status'];
}): MailProvider {
  const sinkDir = opts.sinkDir;
  mkdirSync(sinkDir, { recursive: true });

  return {
    name: 'mail_sink',
    async submit(req: MailSubmitRequest): Promise<MailSubmitResult> {
      if (opts.failSubmit) {
        return {
          ok: false,
          piece_id: '',
          status: 'failed',
          reason: 'mail_sink_submit_failed',
          provider: 'mail_sink',
        };
      }
      const pieceId = `sink_piece_${randomUUID().slice(0, 12)}`;
      const payload = {
        piece_id: pieceId,
        status: 'submitted',
        submitted_at: nowIso(),
        request: req,
      };
      writeFileSync(join(sinkDir, `${pieceId}.json`), JSON.stringify(payload, null, 2));
      const expected = new Date(Date.parse(nowIso()) + 3 * 86400000).toISOString().slice(0, 10);
      return {
        ok: true,
        piece_id: pieceId,
        status: 'submitted',
        reason: 'mail_sink_submitted',
        cost_cents: Number.isFinite(req.expected_cost_cents)
          ? Math.max(0, Number(req.expected_cost_cents))
          : 0,
        expected_delivery_date: expected,
        provider: 'mail_sink',
        raw: payload,
      };
    },
    async getStatus(pieceId: string): Promise<MailStatusResult> {
      const path = join(sinkDir, `${pieceId}.json`);
      if (!existsSync(path)) {
        return {
          piece_id: pieceId,
          status: 'unknown',
          reason: 'mail_sink_piece_not_found',
          provider: 'mail_sink',
        };
      }
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const status = opts.confirmStatus || 'confirmed';
      return {
        piece_id: pieceId,
        status,
        reason: `mail_sink_${status}`,
        delivered_at: status === 'delivered' || status === 'confirmed'
          ? nowIso()
          : undefined,
        provider: 'mail_sink',
        raw,
      };
    },
  };
}

/**
 * Thin Lob HTTP adapter. Requires LOB_API_KEY. Live calls are canary-owned;
 * tests should inject fetchImpl or use the sink.
 */
export function createLobMailProvider(opts: {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): MailProvider {
  const apiKey = text(opts.apiKey || process.env.LOB_API_KEY);
  const baseUrl = text(opts.baseUrl || process.env.LOB_API_BASE || 'https://api.lob.com/v1').replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl || fetch;

  return {
    name: 'lob',
    async submit(req: MailSubmitRequest): Promise<MailSubmitResult> {
      if (!apiKey) {
        return {
          ok: false,
          piece_id: '',
          status: 'failed',
          reason: 'lob_not_configured: missing LOB_API_KEY',
          provider: 'lob',
        };
      }
      const auth = Buffer.from(`${apiKey}:`).toString('base64');
      try {
        const res = await fetchImpl(`${baseUrl}/postcards`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            description: req.treatment,
            to: req.to,
            from: req.from,
            front: req.template_id || undefined,
            merge_variables: req.merge_variables,
            metadata: { record_id: req.recordId, ...(req.metadata || {}) },
          }),
        });
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (!res.ok) {
          return {
            ok: false,
            piece_id: '',
            status: 'failed',
            reason: `lob_http_${res.status}`,
            provider: 'lob',
            raw: body,
          };
        }
        const pieceId = text(body.id || body.piece_id);
        return {
          ok: true,
          piece_id: pieceId,
          status: 'submitted',
          reason: 'lob_submitted',
          cost_cents: body.price != null ? Math.round(Number(body.price) * 100) : undefined,
          expected_delivery_date: text(body.expected_delivery_date),
          provider: 'lob',
          raw: body,
        };
      } catch (err) {
        return {
          ok: false,
          piece_id: '',
          status: 'uncertain',
          reason: `lob_network_error:${String((err as Error)?.message || err)}`,
          provider: 'lob',
          outcome_unknown: true,
        };
      }
    },
    async getStatus(pieceId: string): Promise<MailStatusResult> {
      if (!apiKey) {
        return {
          piece_id: pieceId,
          status: 'unknown',
          reason: 'lob_not_configured',
          provider: 'lob',
        };
      }
      const auth = Buffer.from(`${apiKey}:`).toString('base64');
      try {
        const res = await fetchImpl(`${baseUrl}/postcards/${encodeURIComponent(pieceId)}`, {
          headers: { Authorization: `Basic ${auth}` },
        });
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (!res.ok) {
          return {
            piece_id: pieceId,
            status: 'unknown',
            reason: `lob_http_${res.status}`,
            provider: 'lob',
            raw: body,
          };
        }
        const rawStatus = text(body.status || body.delivery_status).toLowerCase();
        let status: MailStatusResult['status'] = 'submitted';
        if (rawStatus === 'delivered') status = 'delivered';
        else if (rawStatus === 'returned') status = 'returned';
        else if (rawStatus.includes('fail')) status = 'failed';
        else if (rawStatus === 'in_transit' || rawStatus === 'processed_for_delivery') status = 'in_transit';
        return {
          piece_id: pieceId,
          status,
          reason: `lob_status_${rawStatus || 'unknown'}`,
          delivered_at: text(body.date_delivered) || undefined,
          provider: 'lob',
          raw: body,
        };
      } catch (err) {
        return {
          piece_id: pieceId,
          status: 'unknown',
          reason: `lob_network_error:${String((err as Error)?.message || err)}`,
          provider: 'lob',
        };
      }
    },
  };
}

/**
 * Resolve a mail provider from env/config.
 * Prefer sink when AO_MAIL_SINK=1 or provider=sink; else Lob only when
 * explicitly named (channels.mail.provider / AO_MAIL_PROVIDER). Credential
 * presence never selects a live provider — if LOB_API_KEY is set with no
 * declaration and sink is not active, that is a misconfiguration.
 */
export function resolveMailProvider(opts: {
  listDir?: string;
  providerName?: string;
  sinkDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): MailProvider | null {
  const env = opts.env || process.env;
  const name = text(opts.providerName || env.AO_MAIL_PROVIDER || '').toLowerCase();
  const sinkFlag = deliveryModeForChannel('mail', env) === 'sink';
  if (sinkFlag || name === 'sink' || name === 'mail_sink') {
    const sinkDir = opts.sinkDir
      || (opts.listDir ? join(opts.listDir, 'mail-sink') : join(process.cwd(), 'mail-sink'));
    return createMailProviderSink({ sinkDir });
  }
  if (name === 'lob') {
    return createLobMailProvider({
      apiKey: env.LOB_API_KEY,
      baseUrl: env.LOB_API_BASE,
      fetchImpl: opts.fetchImpl,
    });
  }
  // A declared name nothing implements is a misconfiguration, not "no mail".
  // Returning null here would make a typo indistinguishable from a pipeline
  // that deliberately configured no provider, which is the silent-declaration
  // failure this whole change exists to remove.
  if (name) {
    throw new Error(
      `Unknown mail provider "${name}". Declare channels.mail.provider `
      + '(or AO_MAIL_PROVIDER) as "lob" or "sink".',
    );
  }
  // Credential without an explicit provider declaration is ambiguous: the
  // operator set up mail credentials but nothing declared a live provider.
  // Fail loud rather than silently selecting Lob or returning null ("no mail").
  if (text(env.LOB_API_KEY)) {
    throw new Error(
      'LOB_API_KEY is set but no mail provider was declared. '
      + 'Set channels.mail.provider (or AO_MAIL_PROVIDER) to select a live provider, '
      + 'or select sink (AO_MAIL_SINK=1 or provider=sink). '
      + 'A credential never selects a live provider by itself.',
    );
  }
  return null;
}

/** List sink piece files (test helper). */
export function listMailSinkPieces(sinkDir: string): string[] {
  if (!existsSync(sinkDir)) return [];
  return readdirSync(sinkDir).filter((f) => f.endsWith('.json'));
}

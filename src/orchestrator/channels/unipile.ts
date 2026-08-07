/**
 * Unipile LinkedIn adapter.
 *
 * Production linkedin_connect steps call evaluateUnipileReadiness before any
 * network work. Live invitation HTTP runs when credentials are present and
 * fixture mode is off. Fixture mode (AO_UNIPILE_FIXTURE=1) is for harness only.
 */

export const UNIPILE_ENV_KEYS = [
  'UNIPILE_API_KEY',
  'UNIPILE_DSN',
] as const;

export type UnipileReadiness = {
  ready: boolean;
  provider: 'unipile';
  reason: string;
  env_keys_present: string[];
  env_keys_missing: string[];
};

const nonBlank = (value: unknown) => String(value ?? '').trim();

const linkedinPublicIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

const isLinkedinHost = (hostname: string): boolean =>
  hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com');

/**
 * Accept a LinkedIn public profile URL or the provider's bare public identifier.
 * Returns null rather than guessing when the reference cannot identify a profile.
 */
export const parseLinkedinPublicIdentifier = (value: string): string | null => {
  const reference = nonBlank(value);
  if (linkedinPublicIdentifierPattern.test(reference)) return reference;

  try {
    const url = new URL(reference);
    const profileSegments = url.pathname.split('/').filter(Boolean);
    const publicIdentifier = profileSegments[1] || '';
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || !isLinkedinHost(url.hostname.toLowerCase())
      || profileSegments.length !== 2
      || profileSegments[0].toLowerCase() !== 'in'
      || !linkedinPublicIdentifierPattern.test(publicIdentifier)
    ) {
      return null;
    }
    return publicIdentifier;
  } catch {
    return null;
  }
};

const linkedinReferenceShape = (value: string): string => {
  try {
    const url = new URL(value);
    if (isLinkedinHost(url.hostname.toLowerCase())) return 'a LinkedIn non-profile URL';
    return 'a non-LinkedIn URL';
  } catch {
    return 'an unrecognised identifier';
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const responseDetail = (value: unknown): string => {
  if (typeof value === 'string') return nonBlank(value);
  if (Array.isArray(value)) {
    return value.map(responseDetail).filter(Boolean).join('; ');
  }
  const record = asRecord(value);
  if (!record) return '';
  return [record.detail, record.message, record.error_description, record.error, record.errors]
    .map(responseDetail)
    .find(Boolean) || '';
};

const unipileFailureDetail = (payload: unknown, statusText: string): string =>
  responseDetail(payload).replace(/\s+/g, ' ').slice(0, 200)
  || nonBlank(statusText).slice(0, 200)
  || 'error';

const readUnipileJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

/**
 * Contract readiness for LinkedIn via Unipile.
 * Ready when API credentials are present, or when AO_UNIPILE_FIXTURE=1 (harness only).
 */
export function evaluateUnipileReadiness(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = {},
): UnipileReadiness {
  const fixtureMode = nonBlank(env.AO_UNIPILE_FIXTURE) === '1'
    || nonBlank(env.AO_UNIPILE_FIXTURE).toLowerCase() === 'true';
  if (fixtureMode) {
    return {
      ready: true,
      provider: 'unipile',
      reason: 'unipile_fixture_mode',
      env_keys_present: ['AO_UNIPILE_FIXTURE'],
      env_keys_missing: [],
    };
  }
  const present: string[] = [];
  const missing: string[] = [];
  for (const key of UNIPILE_ENV_KEYS) {
    if (nonBlank(env[key])) present.push(key);
    else missing.push(key);
  }
  if (missing.length > 0) {
    return {
      ready: false,
      provider: 'unipile',
      reason: `unipile_not_configured: missing ${missing.join(', ')}`,
      env_keys_present: present,
      env_keys_missing: missing,
    };
  }
  return {
    ready: true,
    provider: 'unipile',
    reason: 'unipile_credentials_present',
    env_keys_present: present,
    env_keys_missing: [],
  };
}

export type UnipileLinkedinConnectInput = {
  record?: Record<string, unknown>;
  step?: { id?: string; description?: string; config?: Record<string, unknown> };
  dryRun?: boolean;
  /** Provider credentials supplied by the pipeline channel configuration. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Optional fetch inject for tests */
  fetchImpl?: typeof fetch;
};

export type UnipileLinkedinConnectResult = {
  status: 'skipped' | 'sent' | 'failed';
  reason: string;
  provider_id: string;
  readiness: UnipileReadiness;
};

/**
 * Live Unipile users/invite HTTP (LinkedIn connection invite).
 * DSN is host base (e.g. https://apiN.unipile.com:PORT).
 */
export async function unipileLiveInvite(input: {
  dsn: string;
  apiKey: string;
  providerId?: string;
  accountId?: string;
  linkedinUrl?: string;
  message?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; provider_id: string; reason: string; status: number }> {
  const base = String(input.dsn || '').replace(/\/$/, '');
  if (!base) {
    return { ok: false, provider_id: '', reason: 'unipile_dsn_empty', status: 0 };
  }
  const publicIdentifier = parseLinkedinPublicIdentifier(input.linkedinUrl || '');
  if (!publicIdentifier) {
    return {
      ok: false,
      provider_id: '',
      reason: `unipile_invalid_linkedin_reference: field linkedinUrl has ${linkedinReferenceShape(input.linkedinUrl || '')}`,
      status: 0,
    };
  }
  const accountId = String(input.accountId || input.providerId || '').trim();
  // Unipile users invitation endpoint (account-scoped).
  const url = accountId
    ? `${base}/api/v1/users/invite?account_id=${encodeURIComponent(accountId)}`
    : `${base}/api/v1/users/invite`;
  const body: Record<string, unknown> = {
    provider: 'LINKEDIN',
    provider_public_id: publicIdentifier,
  };
  if (input.message) body.message = input.message;

  const fetchFn = input.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, provider_id: '', reason: 'unipile_fetch_unavailable', status: 0 };
  }

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'X-API-KEY': input.apiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const status = Number(res.status || 0);
    const payload = await readUnipileJson(res);
    const payloadRecord = asRecord(payload);
    const provider_id = String(
      payloadRecord?.id || payloadRecord?.invitation_id || payloadRecord?.object || '',
    );
    if (status >= 200 && status < 300) {
      return {
        ok: true,
        provider_id: provider_id || `unipile_live_${Date.now()}`,
        reason: 'unipile_live_invite_sent',
        status,
      };
    }
    return {
      ok: false,
      provider_id: provider_id || '',
      reason: `unipile_live_http_${status}:${unipileFailureDetail(payload, res.statusText)}`,
      status,
    };
  } catch (err) {
    return {
      ok: false,
      provider_id: '',
      reason: `unipile_live_network_error:${String((err as Error)?.message || err).slice(0, 200)}`,
      status: 0,
    };
  }
}

/**
 * Production entry for linkedin_connect via Unipile.
 * Gates on readiness; live HTTP when credentials present; fixture for harness.
 */
export async function executeUnipileLinkedinConnect(
  input: UnipileLinkedinConnectInput = {},
): Promise<UnipileLinkedinConnectResult> {
  const readiness = evaluateUnipileReadiness(input.env || {});
  if (!readiness.ready) {
    return {
      status: 'skipped',
      reason: readiness.reason,
      provider_id: '',
      readiness,
    };
  }
  if (input.dryRun) {
    return {
      status: 'skipped',
      reason: 'unipile_dry_run',
      provider_id: '',
      readiness,
    };
  }

  const env = input.env || {};
  // Fixture/contract adapter: when AO_UNIPILE_FIXTURE=1, return deterministic
  // provider success without live HTTP (validation / harness only).
  const fixtureMode = String(env.AO_UNIPILE_FIXTURE || '').trim() === '1'
    || String(env.AO_UNIPILE_FIXTURE || '').toLowerCase() === 'true';
  if (fixtureMode) {
    const rowId = String(input.record?._row_id || input.record?.id || 'unknown');
    const stepId = String(input.step?.id || 'linkedin_connect');
    return {
      status: 'sent',
      reason: 'unipile_fixture_success',
      provider_id: `unipile_fixture_${rowId}_${stepId}`,
      readiness,
    };
  }

  const apiKey = nonBlank(env.UNIPILE_API_KEY);
  const dsn = nonBlank(env.UNIPILE_DSN);
  const linkedinReference = [
    { field: 'contact_linkedin_url', value: nonBlank(input.record?.contact_linkedin_url) },
    { field: 'linkedin_url', value: nonBlank(input.record?.linkedin_url) },
    { field: 'step.config.linkedin_url', value: nonBlank(input.step?.config?.linkedin_url) },
  ].find(({ value }) => Boolean(value));
  const accountId = nonBlank(env.UNIPILE_ACCOUNT_ID || input.step?.config?.unipile_account_id);
  if (!linkedinReference) {
    return {
      status: 'skipped',
      reason: 'unipile_missing_linkedin_url',
      provider_id: '',
      readiness,
    };
  }
  const publicIdentifier = parseLinkedinPublicIdentifier(linkedinReference.value);
  if (!publicIdentifier) {
    return {
      status: 'failed',
      reason: `unipile_invalid_linkedin_reference: field ${linkedinReference.field} has ${linkedinReferenceShape(linkedinReference.value)}`,
      provider_id: '',
      readiness,
    };
  }

  const live = await unipileLiveInvite({
    dsn,
    apiKey,
    accountId,
    linkedinUrl: publicIdentifier,
    message: nonBlank(input.step?.config?.invite_message || input.step?.description),
    fetchImpl: input.fetchImpl,
  });

  if (live.ok) {
    return {
      status: 'sent',
      reason: live.reason,
      provider_id: live.provider_id,
      readiness,
    };
  }
  return {
    status: 'failed',
    reason: live.reason,
    provider_id: live.provider_id || '',
    readiness,
  };
}

/** True when step kind is LinkedIn connect (not a forbidden channel). */
export function isLinkedinConnectKind(kind: string | null | undefined): boolean {
  return String(kind || '').trim().toLowerCase() === 'linkedin_connect';
}

export type UnipileWebhookPayload = {
  event_id?: string;
  event_type?: string;
  type?: string;
  provider_id?: string;
  invitation_id?: string;
  account_id?: string;
  status?: string;
  linkedin_url?: string;
  occurred_at?: string;
  [key: string]: unknown;
};

export type UnipileWebhookReconcileResult = {
  ok: boolean;
  reason: string;
  provider_id: string;
  event_id: string;
  duplicate: boolean;
  out_of_order: boolean;
  patch: Record<string, unknown>;
};

/**
 * Reconcile an inbound Unipile (or fixture) webhook against stored LinkedIn ack state.
 * - First delivery wins for provider_id (never invents a second consequence).
 * - Duplicate event_id is a no-op success.
 * - Out-of-order events with older timestamps do not overwrite newer state.
 */
export function reconcileUnipileWebhook(input: {
  record: Record<string, unknown>;
  payload: UnipileWebhookPayload;
  /** Prior webhook event ids already applied (from channel_events or record). */
  seen_event_ids?: string[];
}): UnipileWebhookReconcileResult {
  const payload = input.payload || {};
  const event_id = String(payload.event_id || payload.invitation_id || '').trim()
    || `wh_${Date.now()}`;
  const provider_id = String(
    payload.provider_id || payload.invitation_id || input.record.linkedin_last_provider_id || '',
  ).trim();
  const seen = new Set((input.seen_event_ids || []).map(String));
  if (seen.has(event_id)) {
    return {
      ok: true,
      reason: 'webhook_duplicate_event',
      provider_id: String(input.record.linkedin_last_provider_id || provider_id),
      event_id,
      duplicate: true,
      out_of_order: false,
      patch: {},
    };
  }

  const existingProvider = String(input.record.linkedin_last_provider_id || '').trim();
  const existingAt = String(input.record.linkedin_webhook_at || input.record.linkedin_last_connect_at || '');
  const incomingAt = String(payload.occurred_at || new Date().toISOString());
  let out_of_order = false;
  if (existingAt && incomingAt) {
    const prev = Date.parse(existingAt);
    const next = Date.parse(incomingAt);
    if (Number.isFinite(prev) && Number.isFinite(next) && next < prev) {
      out_of_order = true;
    }
  }

  // First provider_id wins — never replace with a different consequence.
  if (existingProvider && provider_id && existingProvider !== provider_id) {
    return {
      ok: true,
      reason: 'webhook_ignored_conflicting_provider_id',
      provider_id: existingProvider,
      event_id,
      duplicate: false,
      out_of_order,
      patch: {
        linkedin_webhook_last_event_id: event_id,
        linkedin_webhook_status: 'ignored_conflict',
      },
    };
  }

  if (out_of_order) {
    return {
      ok: true,
      reason: 'webhook_out_of_order_ignored',
      provider_id: existingProvider || provider_id,
      event_id,
      duplicate: false,
      out_of_order: true,
      patch: {
        linkedin_webhook_last_event_id: event_id,
        linkedin_webhook_status: 'out_of_order_ignored',
      },
    };
  }

  const status = String(payload.status || payload.event_type || payload.type || 'accepted');
  return {
    ok: true,
    reason: 'webhook_reconciled',
    provider_id: existingProvider || provider_id,
    event_id,
    duplicate: false,
    out_of_order: false,
    patch: {
      linkedin_last_provider_id: existingProvider || provider_id,
      linkedin_webhook_status: status,
      linkedin_webhook_at: incomingAt,
      linkedin_webhook_last_event_id: event_id,
    },
  };
}

import { isBudgetExceededError } from '../runtime/contract.js';

/**
 * Structured HTTP status on a provider error, when the transport/provider
 * attached one. Prefer this over parsing message text.
 *
 * Sources (first match wins):
 * - `error.status` / `error.statusCode` (common on thrown provider errors)
 * - `error.failure.status` (email-verification failure envelope)
 */
export const providerHttpStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as {
    status?: unknown;
    statusCode?: unknown;
    failure?: { status?: unknown };
  };
  for (const candidate of [e.status, e.statusCode, e.failure?.status]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 100 && n <= 599) return Math.trunc(n);
  }
  return undefined;
};

/**
 * HTTP statuses worth retrying the *same* request:
 * - 429 rate limit
 * - 5xx provider/server failure
 *
 * All other 4xx are client errors — the identical request will not succeed.
 */
export const isRetryableHttpStatus = (status: number): boolean => {
  if (!Number.isFinite(status)) return false;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
};

const errorMessageText = (error: unknown) => (
  String((error as { message?: unknown })?.message || error || '').toLowerCase()
);

/**
 * Explicitly non-retryable provider failures. When true, the engine must not
 * re-attempt the identical request (in-process or on later runs).
 *
 * Classification order:
 * 1. Budget exceeded.
 * 2. Structured HTTP status when present → all 4xx except 429 (status wins over flags/messages).
 * 3. Explicit `retryable: false` on the error object.
 * 4. Message-text client-error signals only when no status is available.
 *
 * Unknown errors (e.g. bare `new Error('provider_declined')`) are NOT non-retryable:
 * the enrich runner's historical in-process second attempt is preserved for those.
 */
export const isNonRetryableProviderError = (error: unknown): boolean => {
  if (isBudgetExceededError(error)) return true;

  const status = providerHttpStatus(error);
  if (status !== undefined && status >= 400 && status <= 599) {
    // Real status available: do not consult message text.
    return !isRetryableHttpStatus(status);
  }

  if (error && typeof error === 'object') {
    const e = error as { retryable?: unknown; code?: unknown };
    if (e.retryable === false) return true;
    if (String(e.code || '') === 'BUDGET_EXCEEDED') return true;
  }

  // Message-only path: structured status was not available.
  const msg = errorMessageText(error);
  if (!msg.trim()) return false;
  if (/\b(invalid[_\s-]?argument|not[_\s-]?found|unauthorized|forbidden|tool_not_connected|unsupported)\b/.test(msg)) {
    return true;
  }
  if (/\b(?:http\s*)?(400|401|403|404|422)\b/.test(msg) && !/\b(?:http\s*)?(429|5\d\d)\b/.test(msg)) {
    return true;
  }
  return false;
};

/**
 * Whether a provider failure is positively retryable (waterfall advance, 429/5xx).
 * Used by tool_call waterfall. Stricter than "not non-retryable": unknown
 * messages only match known transient transport patterns.
 */
export const isRetryableProviderError = (error: unknown): boolean => {
  if (isNonRetryableProviderError(error)) return false;

  const status = providerHttpStatus(error);
  if (status !== undefined && status >= 400 && status <= 599) {
    return isRetryableHttpStatus(status);
  }

  if (error && typeof error === 'object') {
    const e = error as { retryable?: unknown };
    if (e.retryable === true) return true;
  }

  // Message-only path for transient transport / rate-limit signals.
  const msg = errorMessageText(error);
  if (!msg.trim()) return false;
  return (
    /\b(429|502|503|504|timeout|timed out|etimedout|econnreset|econnrefused|enotfound|socket hang up|rate.?limit|temporar(y|ily)|unavailable|overloaded|try again|retry)\b/.test(msg)
    || /\b5\d\d\b/.test(msg)
  );
};

/** True when the error carries a non-empty Retry-After (rate-limit deferral). */
export const providerRetryAfter = (error: unknown): string => (
  error
  && typeof error === 'object'
    ? String((error as { retry_after?: unknown }).retry_after || '').trim()
    : ''
);

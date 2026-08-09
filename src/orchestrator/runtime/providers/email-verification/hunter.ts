import { getEnv } from '../../env.js';
import type {
  EmailVerificationFailure,
  EmailVerificationOutcome,
  EmailVerificationProvider,
  EmailVerificationResult,
} from './types.js';

export type HunterEmailVerification = Required<Pick<
  EmailVerificationResult,
  'status' | 'confidence' | 'smtp_check' | 'disposable'
>>;

const text = (value: unknown) => String(value || '').trim();

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const numeric = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const verificationPayload = (payload: unknown): Record<string, unknown> => {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  return Object.keys(data).length > 0 ? data : root;
};

const failureForResponse = (response: Response): EmailVerificationFailure => {
  const status = response.status;
  const retryAfter = text(response.headers.get('retry-after')) || undefined;
  if (status === 429) {
    return {
      cause: 'quota',
      message: 'Hunter verification quota exhausted for this billing period.',
      retryable: true,
      status,
      retry_after: retryAfter,
    };
  }
  if ([401, 403].includes(status)) {
    return {
      cause: 'authentication',
      message: 'Hunter rejected the verification credential.',
      retryable: false,
      status,
      retry_after: retryAfter,
    };
  }
  if ([408, 504].includes(status)) {
    return {
      cause: 'timeout',
      message: 'Hunter did not complete the verification request in time.',
      retryable: true,
      status,
      retry_after: retryAfter,
    };
  }
  if (status >= 500) {
    return {
      cause: 'transport',
      message: 'Hunter is temporarily unavailable for email verification.',
      retryable: true,
      status,
      retry_after: retryAfter,
    };
  }
  return {
    cause: 'provider',
    message: 'Hunter rejected the email-verification request.',
    retryable: false,
    status,
    retry_after: retryAfter,
  };
};

const failureForTransportError = (error: unknown): EmailVerificationFailure => {
  const detail = text(error instanceof Error ? error.message : error).toLowerCase();
  const timeout = /abort|timeout|timed out|etimedout/.test(detail);
  return timeout
    ? {
      cause: 'timeout',
      message: 'Hunter email verification timed out before a verdict was returned.',
      retryable: true,
    }
    : {
      cause: 'transport',
      message: 'Hunter email verification could not reach the provider.',
      retryable: true,
    };
};

export const verifyHunterEmail = async ({
  email,
  apiKey = getEnv('HUNTER_API_KEY'),
  fetchImpl = globalThis.fetch,
}: {
  email: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<EmailVerificationOutcome> => {
  const normalizedEmail = text(email);
  const normalizedApiKey = text(apiKey);
  if (!normalizedEmail) return { kind: 'no_opinion', reason: 'email_missing' };
  if (!normalizedApiKey) {
    return {
      kind: 'failure',
      failure: {
        cause: 'configuration',
        message: 'Hunter email verification is not configured with an API key.',
        retryable: false,
      },
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      kind: 'failure',
      failure: {
        cause: 'configuration',
        message: 'Hunter email verification has no HTTP transport configured.',
        retryable: false,
      },
    };
  }

  const url = new URL('https://api.hunter.io/v2/email-verifier');
  url.searchParams.set('email', normalizedEmail);
  url.searchParams.set('api_key', normalizedApiKey);
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) return { kind: 'failure', failure: failureForResponse(response) };
    const payload = await response.json().catch(() => null);
    if (!payload) {
      return {
        kind: 'failure',
        failure: {
          cause: 'provider',
          message: 'Hunter returned an unreadable email-verification response.',
          retryable: true,
          status: response.status,
        },
      };
    }
    const data = verificationPayload(payload);
    const status = text(data.status).toLowerCase();
    if (!status) return { kind: 'no_opinion', reason: 'provider_has_no_opinion' };
    return {
      kind: 'verdict',
      verification: {
        status,
        confidence: Math.max(0, Math.min(100, numeric(data.score))),
        smtp_check: data.smtp_check === true,
        disposable: data.disposable === true,
      },
    };
  } catch (error) {
    return { kind: 'failure', failure: failureForTransportError(error) };
  }
};

export class HunterEmailVerificationProvider implements EmailVerificationProvider {
  id = 'hunter';

  async verify({ email }: { email: string }) {
    return verifyHunterEmail({ email });
  }
}

import { getEnv } from '../../env.js';
import type { EmailVerificationProvider, EmailVerificationResult } from './types.js';

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

export const verifyHunterEmail = async ({
  email,
  apiKey = getEnv('HUNTER_API_KEY'),
  fetchImpl = globalThis.fetch,
}: {
  email: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<HunterEmailVerification | null> => {
  const normalizedEmail = text(email);
  const normalizedApiKey = text(apiKey);
  if (!normalizedEmail || !normalizedApiKey || typeof fetchImpl !== 'function') return null;

  const url = new URL('https://api.hunter.io/v2/email-verifier');
  url.searchParams.set('email', normalizedEmail);
  url.searchParams.set('api_key', normalizedApiKey);
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const data = verificationPayload(await response.json());
    const status = text(data.status).toLowerCase();
    if (!status) return null;
    return {
      status,
      confidence: Math.max(0, Math.min(100, numeric(data.score))),
      smtp_check: data.smtp_check === true,
      disposable: data.disposable === true,
    };
  } catch {
    return null;
  }
};

export class HunterEmailVerificationProvider implements EmailVerificationProvider {
  id = 'hunter';

  async verify({ email }: { email: string }) {
    return verifyHunterEmail({ email });
  }
}

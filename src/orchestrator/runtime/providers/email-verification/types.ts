export type EmailVerificationResult = {
  status: string;
  confidence: number;
  reason?: string;
  smtp_check?: boolean;
  disposable?: boolean;
};

export type EmailVerificationFailureCause =
  | 'authentication'
  | 'configuration'
  | 'quota'
  | 'provider'
  | 'timeout'
  | 'transport';

export type EmailVerificationFailure = {
  cause: EmailVerificationFailureCause;
  message: string;
  retryable: boolean;
  status?: number;
  retry_after?: string;
};

export type EmailVerificationOutcome =
  | { kind: 'verdict'; verification: EmailVerificationResult }
  | { kind: 'no_opinion'; reason: string }
  | { kind: 'failure'; failure: EmailVerificationFailure };

export type EmailVerificationProviderFailureError = Error & {
  provider: string;
  failure: EmailVerificationFailure;
  retry_after?: string;
  retryable: boolean;
  status?: number;
};

export const emailVerificationProviderFailureError = ({
  provider,
  failure,
}: {
  provider: string;
  failure: EmailVerificationFailure;
}): EmailVerificationProviderFailureError => {
  const status = Number.isFinite(Number(failure.status)) ? ` (HTTP ${Number(failure.status)})` : '';
  const retryAfter = String(failure.retry_after || '').trim();
  const retry = retryAfter ? ` Retry-After: ${retryAfter}.` : '';
  return Object.assign(
    new Error(`Email-verification provider "${provider}" failed: ${failure.cause}${status}. ${failure.message}${retry}`),
    {
      provider,
      failure,
      retry_after: retryAfter || undefined,
      retryable: failure.retryable,
      status: failure.status,
    },
  );
};

export interface EmailVerificationProvider {
  id: string;
  verify(input: { email: string }): Promise<EmailVerificationOutcome>;
}

export type EmailVerificationProviderFactory = {
  create(): EmailVerificationProvider;
};

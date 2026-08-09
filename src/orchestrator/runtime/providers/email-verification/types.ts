export type EmailVerificationResult = {
  status: string;
  confidence: number;
  reason?: string;
  smtp_check?: boolean;
  disposable?: boolean;
};

export interface EmailVerificationProvider {
  id: string;
  verify(input: { email: string }): Promise<EmailVerificationResult | null>;
}

export type EmailVerificationProviderFactory = {
  create(): EmailVerificationProvider;
};

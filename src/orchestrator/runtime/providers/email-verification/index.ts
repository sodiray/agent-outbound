import { HunterEmailVerificationProvider } from './hunter.js';
import type { EmailVerificationProvider, EmailVerificationProviderFactory } from './types.js';

export type {
  EmailVerificationProvider,
  EmailVerificationProviderFactory,
  EmailVerificationResult,
} from './types.js';

export const DEFAULT_EMAIL_VERIFICATION_PROVIDER = 'hunter';

const builtInFactories: Record<string, EmailVerificationProviderFactory> = {
  hunter: { create: () => new HunterEmailVerificationProvider() },
};

const normalizedProviderId = (value: string | undefined) => (
  String(value || DEFAULT_EMAIL_VERIFICATION_PROVIDER).trim().toLowerCase()
    || DEFAULT_EMAIL_VERIFICATION_PROVIDER
);

export const resolveEmailVerificationProvider = ({
  provider,
  factories = builtInFactories,
}: {
  provider?: string;
  factories?: Record<string, EmailVerificationProviderFactory>;
}): EmailVerificationProvider => {
  const id = normalizedProviderId(provider);
  const factory = factories[id];
  if (!factory) throw new Error(`Unknown email-verification provider "${id}".`);
  return factory.create();
};

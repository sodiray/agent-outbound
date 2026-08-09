export type ProviderDeliveryChannel = 'email' | 'linkedin' | 'mail';
export type ProviderDeliveryMode = 'live' | 'sink';

const normalized = (value: unknown) => String(value ?? '').trim().toLowerCase();

const enabled = (value: unknown) => ['1', 'true'].includes(normalized(value));

export const deliveryModeForChannel = (
  channel: ProviderDeliveryChannel,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ProviderDeliveryMode => {
  if (channel === 'email') return normalized(env.AO_SMTP_SINK) === '1' ? 'sink' : 'live';
  if (channel === 'linkedin') return enabled(env.AO_UNIPILE_FIXTURE) ? 'sink' : 'live';
  return enabled(env.AO_MAIL_SINK) ? 'sink' : 'live';
};

import { basename } from 'node:path';
import {
  resolveCredentials,
  type Credentials,
  type CredentialsDeclaration,
} from './credentials.js';

type ChannelConfig = Record<string, unknown>;

export type ChannelProviderCredentials = {
  ready: boolean;
  credentials: Credentials;
  provider: string;
  missingKeys: string[];
  reason: string;
  source: 'path' | 'inline' | 'merged' | 'unresolved';
  path: string;
};

const nonBlank = (value: unknown) => String(value ?? '').trim();

const isObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const pipelineName = (config: Record<string, unknown>, listDir: string) => {
  const list = isObject(config.list) ? config.list : {};
  return nonBlank(list.name) || basename(listDir) || 'unnamed pipeline';
};

const channelConfig = (config: Record<string, unknown>, channel: string): ChannelConfig => {
  const channels = isObject(config.channels) ? config.channels : {};
  return isObject(channels[channel]) ? channels[channel] : {};
};

export const resolveChannelProviderCredentials = ({
  listDir,
  config,
  channel,
  provider,
  requiredKeys,
}: {
  listDir: string;
  config: Record<string, unknown>;
  channel: string;
  provider: string;
  requiredKeys: readonly string[];
}): ChannelProviderCredentials => {
  const configured = channelConfig(config, channel);
  const declared = configured.credentials;
  const name = pipelineName(config, listDir);
  const missingFrom = (credentials: Credentials) => requiredKeys.filter((key) => !nonBlank(credentials[key]));
  const unavailable = (missingKeys: string[], detail = '', path = ''): ChannelProviderCredentials => ({
    ready: false,
    credentials: {},
    provider,
    missingKeys,
    reason: `Pipeline "${name}" provider "${provider}" credentials unavailable: missing ${missingKeys.join(', ')}${detail}`,
    source: 'unresolved',
    path,
  });

  if (typeof declared !== 'string' && !isObject(declared)) {
    return unavailable([...requiredKeys], ` (channels.${channel}.credentials is not declared)`);
  }

  try {
    const resolved = resolveCredentials({
      credentials: declared as CredentialsDeclaration,
      yamlDir: listDir,
      subject: `pipeline "${name}" channel "${channel}" provider "${provider}"`,
    });
    const missingKeys = missingFrom(resolved.credentials);
    if (missingKeys.length > 0) return unavailable(missingKeys, '', resolved.path);
    return {
      ready: true,
      credentials: resolved.credentials,
      provider,
      missingKeys: [],
      reason: `pipeline_credentials_${resolved.source}`,
      source: resolved.source,
      path: resolved.path,
    };
  } catch (error) {
    const detail = String((error as Error).message || error).replace(/^Credentials file not found for .+?: /, ' (credentials file not found: ');
    return unavailable([...requiredKeys], detail.endsWith(')') ? detail : `${detail})`);
  }
};

import { randomUUID } from 'node:crypto';
import { readConfig, writeConfig } from '../orchestrator/lib/config.js';
import { AgentOutboundError } from '../orchestrator/runtime/contract.js';
import { resolveListDir } from '../orchestrator/runtime/paths.js';

const nowIso = () => new Date().toISOString();

const normalizeTemplateVersions = (template: any) => {
  const versions = Array.isArray(template?.versions) ? template.versions : [];
  return versions
    .map((version: any) => ({
      version: Number(version?.version || 0),
      subject: String(version?.subject || ''),
      body: String(version?.body || ''),
      variables: version?.variables && typeof version.variables === 'object' ? version.variables : {},
      created_at: String(version?.created_at || ''),
      note: String(version?.note || ''),
    }))
    .filter((version: any) => Number(version.version) > 0)
    .sort((a: any, b: any) => Number(a.version || 0) - Number(b.version || 0));
};

export const templatesListCommand = ({ list }: { list: string }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const templates = config?.templates && typeof config.templates === 'object' ? config.templates : {};
  const rows = Object.entries(templates).map(([id, value]: [string, any]) => {
    const versions = normalizeTemplateVersions(value);
    const latest = versions[versions.length - 1] || null;
    return {
      id,
      channel_hint: String(value?.channel_hint || ''),
      latest_version: Number(latest?.version || 0),
      versions: versions.length,
      updated_at: String(value?.updated_at || latest?.created_at || ''),
    };
  }).sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
  return {
    count: rows.length,
    templates: rows,
  };
};

export const templatesShowCommand = ({ list, templateId }: { list: string; templateId: string }) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const templates = config?.templates && typeof config.templates === 'object' ? config.templates : {};
  const key = String(templateId || '').trim();
  const template = templates[key];
  if (!template) {
    throw new AgentOutboundError({
      code: 'NOT_FOUND',
      message: `Template not found: ${templateId}`,
      retryable: false,
    });
  }
  return {
    id: key,
    channel_hint: String(template?.channel_hint || ''),
    versions: normalizeTemplateVersions(template),
    created_at: String(template?.created_at || ''),
    updated_at: String(template?.updated_at || ''),
  };
};

export const templatesCreateCommand = ({
  list,
  templateId,
  channelHint = '',
  subject = '',
  body = '',
  variablesJson = '{}',
}: {
  list: string;
  templateId: string;
  channelHint?: string;
  subject?: string;
  body?: string;
  variablesJson?: string;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const templates = config?.templates && typeof config.templates === 'object' ? config.templates : {};
  const id = String(templateId || '').trim();
  if (!id) {
    throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: '--id is required.', retryable: false });
  }
  if (templates[id]) {
    throw new AgentOutboundError({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      message: `Template already exists: ${id}`,
      retryable: false,
    });
  }
  let variables = {};
  try {
    variables = variablesJson ? JSON.parse(String(variablesJson || '{}')) : {};
  } catch {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: 'Invalid --variables JSON.',
      retryable: false,
    });
  }
  const now = nowIso();
  const version = {
    version: 1,
    subject: String(subject || ''),
    body: String(body || ''),
    variables: variables && typeof variables === 'object' ? variables : {},
    created_at: now,
    note: 'initial version',
  };
  const next = {
    ...config,
    templates: {
      ...templates,
      [id]: {
        id,
        channel_hint: String(channelHint || ''),
        versions: [version],
        created_at: now,
        updated_at: now,
        uuid: randomUUID(),
      },
    },
  };
  const write = writeConfig(listDir, next);
  if (!write.written) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: write.errors.join('; ') || 'Failed to write config.',
      retryable: false,
    });
  }
  return {
    status: 'created',
    id,
    version: 1,
  };
};

export const templatesUpdateCommand = ({
  list,
  templateId,
  subject = '',
  body = '',
  variablesJson = '',
  note = '',
}: {
  list: string;
  templateId: string;
  subject?: string;
  body?: string;
  variablesJson?: string;
  note?: string;
}) => {
  const listDir = resolveListDir(list);
  const { config } = readConfig(listDir);
  const templates = config?.templates && typeof config.templates === 'object' ? config.templates : {};
  const id = String(templateId || '').trim();
  const template = templates[id];
  if (!template) {
    throw new AgentOutboundError({ code: 'NOT_FOUND', message: `Template not found: ${templateId}`, retryable: false });
  }
  const versions = normalizeTemplateVersions(template);
  const latest = versions[versions.length - 1] || {
    version: 0,
    subject: '',
    body: '',
    variables: {},
  };
  let variables = latest.variables;
  if (variablesJson) {
    try {
      variables = JSON.parse(String(variablesJson));
    } catch {
      throw new AgentOutboundError({ code: 'INVALID_ARGUMENT', message: 'Invalid --variables JSON.', retryable: false });
    }
  }
  const nextVersion = {
    version: Number(latest.version || 0) + 1,
    subject: subject ? String(subject) : String(latest.subject || ''),
    body: body ? String(body) : String(latest.body || ''),
    variables: variables && typeof variables === 'object' ? variables : {},
    created_at: nowIso(),
    note: String(note || ''),
  };
  const next = {
    ...config,
    templates: {
      ...templates,
      [id]: {
        ...template,
        versions: [...versions, nextVersion],
        updated_at: nowIso(),
      },
    },
  };
  const write = writeConfig(listDir, next);
  if (!write.written) {
    throw new AgentOutboundError({
      code: 'INVALID_ARGUMENT',
      message: write.errors.join('; ') || 'Failed to write config.',
      retryable: false,
    });
  }
  return {
    status: 'updated',
    id,
    version: nextVersion.version,
  };
};


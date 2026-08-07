import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type Credentials = Record<string, string>;

export type CredentialsDeclaration = string | Record<string, unknown>;

export type ResolvedCredentials = {
  credentials: Credentials;
  source: 'path' | 'inline' | 'merged';
  path: string;
};

const nonBlank = (value: unknown) => String(value ?? '').trim();

const isObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const parseEnvFile = (text: string): Credentials => {
  const output: Credentials = {};
  for (const sourceLine of String(text || '').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equals = withoutExport.indexOf('=');
    if (equals <= 0) continue;
    const key = withoutExport.slice(0, equals).trim();
    const raw = withoutExport.slice(equals + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const quoted = raw.match(/^(['"])([\s\S]*)\1$/);
    output[key] = quoted ? quoted[2].replace(/\\n/g, '\n').replace(/\\r/g, '\r') : raw.replace(/\s+#.*$/, '').trim();
  }
  return output;
};

export const resolveCredentials = ({
  credentials,
  yamlDir,
  subject,
}: {
  credentials: CredentialsDeclaration;
  yamlDir: string;
  subject: string;
}): ResolvedCredentials => {
  if (typeof credentials === 'string') {
    const path = isAbsolute(credentials) ? credentials : join(yamlDir, credentials);
    if (!existsSync(path)) throw new Error(`Credentials file not found for ${subject}: ${path}`);
    return { credentials: parseEnvFile(readFileSync(path, 'utf8')), source: 'path', path };
  }

  const values = isObject(credentials) ? credentials : {};
  const pathValue = nonBlank(values.path);
  const overrides = Object.fromEntries(Object.entries(values)
    .filter(([key]) => key !== 'path')
    .map(([key, value]) => [key, String(value ?? '')]));
  if (!pathValue) return { credentials: overrides, source: 'inline', path: '' };

  const path = isAbsolute(pathValue) ? pathValue : join(yamlDir, pathValue);
  if (!existsSync(path)) throw new Error(`Credentials file not found for ${subject}: ${path}`);
  return {
    credentials: { ...parseEnvFile(readFileSync(path, 'utf8')), ...overrides },
    source: 'merged',
    path,
  };
};

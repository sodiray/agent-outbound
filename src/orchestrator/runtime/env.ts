import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getGlobalEnvPath, ensureGlobalDirs } from './paths.js';

const parseEnvText = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
};

export const readGlobalEnv = (): Record<string, string> => {
  const envPath = getGlobalEnvPath();
  if (!existsSync(envPath)) return {};
  return parseEnvText(readFileSync(envPath, 'utf8'));
};

export const writeGlobalEnv = (pairs: Record<string, string>) => {
  ensureGlobalDirs();
  const existing = readGlobalEnv();
  const merged = { ...existing, ...pairs };
  const lines = Object.entries(merged)
    .filter(([, value]) => String(value || '').trim() !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`);

  const envPath = getGlobalEnvPath();
  writeFileSync(envPath, `${lines.join('\n')}\n`);
  chmodSync(envPath, 0o600);
  return envPath;
};

export const getEnv = (key: string) => {
  const fromProcess = String(process.env[key] || '').trim();
  if (fromProcess) return fromProcess;
  const globalEnv = readGlobalEnv();
  return String(globalEnv[key] || '').trim();
};

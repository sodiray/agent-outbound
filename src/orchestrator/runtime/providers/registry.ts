import { ComposioProvider } from './composio.js';
import { CommandProvider } from './command.js';
import { registryServerEntry } from '../../lib/provider-registry.js';
import type { ToolProvider } from './types.js';

type ProviderLookupOptions = {
  listDir?: string;
};

export class ProviderRegistry {
  private composioProvider: ComposioProvider | null = null;
  private providersByList = new Map<string, Map<string, ToolProvider>>();

  getProvider(id = '', options: ProviderLookupOptions = {}): ToolProvider {
    const normalized = String(id || '').trim().toLowerCase();
    if (!normalized || normalized === 'composio') return this.getDefaultProvider();
    const listDir = String(options.listDir || '').trim();
    if (!listDir) {
      throw new Error(`Unknown tool provider "${id}". A list directory is required for custom providers.`);
    }

    const cached = this.providersByList.get(listDir)?.get(normalized);
    if (cached) return cached;

    const entry = registryServerEntry(listDir, normalized);
    if (!entry) {
      throw new Error(`Unknown tool provider "${id}" in ${listDir}/mcp.json.`);
    }
    const registryName = entry.name;
    const server = entry.server;
    if (server.type === 'stdio' || server.type === 'http') {
      throw new Error(`Tool provider "${id}" uses type "${server.type}", which is not implemented until P3.`);
    }

    const provider = new CommandProvider(registryName, server);
    const byName = this.providersByList.get(listDir) || new Map<string, ToolProvider>();
    byName.set(normalized, provider);
    this.providersByList.set(listDir, byName);
    return provider;
  }

  getDefaultProvider(): ToolProvider {
    if (!this.composioProvider) {
      this.composioProvider = new ComposioProvider();
    }
    return this.composioProvider;
  }

  async closeAll() {
    const customProviders = [...this.providersByList.values()].flatMap((byName) => [...byName.values()]);
    await Promise.all(customProviders.map((provider) => provider.close?.()));
    this.providersByList.clear();
    if (!this.composioProvider) return;
    await this.composioProvider.close?.();
    this.composioProvider = null;
  }
}

const defaultRegistry = new ProviderRegistry();

export const getProvider = (id?: string, options: ProviderLookupOptions = {}) => defaultRegistry.getProvider(id, options);
export const getDefaultProvider = () => defaultRegistry.getDefaultProvider();
export const closeAllProviders = () => defaultRegistry.closeAll();

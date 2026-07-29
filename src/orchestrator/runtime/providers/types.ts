export type ProviderParameterLocation = 'path' | 'query' | 'body';

export type ProviderToolSchema = {
  slug: string;
  server: string;
  toolkit?: string;
  provider?: string;
  endpoint?: string;
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  parameter_locations?: Record<string, ProviderParameterLocation>;
  parameter_collisions?: Record<string, ProviderParameterLocation[]>;
};

export interface ToolProvider {
  id: string;
  searchTools(queries: Array<string | Record<string, unknown>>, limit?: number): Promise<ProviderToolSchema[]>;
  getSchemas(slugs: string[]): Promise<ProviderToolSchema[]>;
  executeTool(slug: string, args: Record<string, unknown>): Promise<unknown>;
  registerSchemas?(schemas: ProviderToolSchema[]): void;
  resolveToolkitToolSlugs?(toolkits: string[]): Promise<string[]>;
  listToolkits?(): Promise<string[]>;
  checkAvailability?(toolkits: string[]): Promise<Record<string, boolean>>;
  close?(): Promise<void>;
}

export type ProviderToolSchema = {
  slug: string;
  server: string;
  toolkit?: string;
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
};

export interface ToolProvider {
  id: string;
  searchTools(queries: Array<string | Record<string, unknown>>, limit?: number): Promise<ProviderToolSchema[]>;
  getSchemas(slugs: string[]): Promise<ProviderToolSchema[]>;
  executeTool(slug: string, args: Record<string, unknown>): Promise<unknown>;
  resolveToolkitToolSlugs?(toolkits: string[]): Promise<string[]>;
  listToolkits?(): Promise<string[]>;
  checkAvailability?(toolkits: string[]): Promise<Record<string, boolean>>;
  close?(): Promise<void>;
}

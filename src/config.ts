import path from 'node:path';

// Process-level configuration. These can only be set through environment
// variables because changing them requires a restart. Everything tunable at
// runtime lives in settings.ts and is editable from the web UI.
export const config = {
  docsDir: path.resolve(process.env.RAGBOX_DOCS_DIR ?? '/docs'),
  dataDir: path.resolve(process.env.RAGBOX_DATA_DIR ?? '/data'),
  host: process.env.RAGBOX_HOST ?? '0.0.0.0',
  port: Number(process.env.RAGBOX_PORT ?? 8080),
  // Optional bearer token required on the /mcp endpoint.
  mcpToken: process.env.RAGBOX_MCP_TOKEN || undefined,
};

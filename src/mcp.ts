import type { Request, Response, Router } from 'express';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from './config.js';
import { errorMessage } from './log.js';
import { search, type SearchResult } from './search.js';

const VERSION = '0.1.0';

function buildServer(): McpServer {
  const server = new McpServer({ name: 'ragbox', version: VERSION });
  server.registerTool(
    'search',
    {
      title: 'Search documents',
      description:
        'Semantic + keyword search over the local document collection indexed by ragbox. ' +
        'Returns the most relevant text passages with their file path. Images and audio recordings (when the embedding model supports them) ' +
        'are matched by their content and returned as a reference with the file path and, for audio, the time range. ' +
        'Phrase the query as a natural-language question or topic.',
      inputSchema: {
        query: z.string().min(1).describe('What to search for'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of passages to return (default 8)'),
        path_prefix: z.string().optional().describe('Only search files under this relative folder, e.g. "projects/acme/"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit, path_prefix }) => {
      try {
        const results = await search({ query, limit, pathPrefix: path_prefix });
        return {
          content: [{ type: 'text', text: formatResults(query, results) }],
          structuredContent: { results },
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Search failed: ${errorMessage(err)}` }] };
      }
    },
  );
  return server;
}

function formatResults(query: string, results: SearchResult[]): string {
  if (!results.length) return `No results for "${query}".`;
  return results
    .map((r, i) => {
      const where = [r.path, r.section?.replace(/^#+\s*/, '')].filter(Boolean).join(' › ');
      const sim = r.similarity === null ? 'keyword match' : `similarity ${r.similarity.toFixed(3)}`;
      return `[${i + 1}] ${where} (chunk ${r.chunk}, ${sim})\n${r.content}`;
    })
    .join('\n\n---\n\n');
}

/** Stateless Streamable HTTP MCP endpoint: a fresh server/transport per request. */
export function mcpRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.use((req, res, next) => {
    if (!config.mcpToken) return next();
    if (req.headers.authorization === `Bearer ${config.mcpToken}`) return next();
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  });

  router.post('/', async (req: Request, res: Response) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: errorMessage(err) }, id: null });
      }
    }
  });

  // Stateless server: no SSE stream or session to resume/terminate.
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  };
  router.get('/', notAllowed);
  router.delete('/', notAllowed);
  return router;
}

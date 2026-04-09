import express from 'express';
import { randomUUID } from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const PORT = process.env.PORT || 3000;

const server = new McpServer({
  name: 'shopify-mcp',
  version: '1.0.0'
});

server.tool(
  'test_connection',
  {
    message: z.string().optional()
  },
  async ({ message }) => {
    return {
      content: [
        {
          type: 'text',
          text: `MCP working. Message: ${message || 'none'}`
        }
      ]
    };
  }
);

const app = express();

const mcpApp = createMcpExpressApp(server, {
  basePath: '/mcp',
  verboseLogs: true,
  transport: (_req) =>
    new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true
    })
});

app.use('/mcp', mcpApp);

app.get('/', (_req, res) => {
  res.send('Shopify MCP server running');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

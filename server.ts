import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

const mcpServer = new McpServer({
  name: 'shopify-mcp',
  version: '1.0.0',
});

mcpServer.registerTool(
  'test_connection',
  {
    title: 'Test Connection',
    description: 'Simple MCP connectivity test',
    inputSchema: {
      message: z.string().optional(),
    },
  },
  async ({ message }) => {
    return {
      content: [
        {
          type: 'text',
          text: `MCP working. Message: ${message || 'none'}`,
        },
      ],
    };
  }
);

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});

await mcpServer.connect(transport);

app.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Shopify MCP server running',
    mcpEndpoint: '/mcp',
  });
});

app.all('/mcp', async (req, res) => {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Unknown server error',
        },
        id: null,
      });
    }
  }
});

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Shopify MCP server running on port ${port}`);
});

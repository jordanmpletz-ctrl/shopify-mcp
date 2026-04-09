import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

if (!SHOPIFY_STORE_DOMAIN) {
  throw new Error('Missing SHOPIFY_STORE_DOMAIN');
}

if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
  throw new Error('Missing SHOPIFY_ADMIN_ACCESS_TOKEN');
}

const shopifyEndpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(shopifyEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Error(`Shopify HTTP error ${response.status}: ${JSON.stringify(json)}`);
  }

  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  if (!json.data) {
    throw new Error('Shopify returned no data');
  }

  return json.data;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => cleanText(v)).filter(Boolean))];
}

function uniqueTags(tags) {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function buildPrimaryTitle(brand, productName, colour) {
  return `${brand} - ${productName} in ${colour}`;
}

function buildPrimaryTags(input) {
  return uniqueTags([
    input.brand,
    input.productName,
    input.colour,
    input.productType || '',
    input.category || '',
    input.model || '',
    ...(input.tags || [])
  ]);
}

function buildImageInputs(imageUrls, brand) {
  return imageUrls.map((url, index) => ({
    originalSource: url,
    mediaContentType: 'IMAGE',
    alt: `${brand} image ${index + 1}`
  }));
}

const mcpServer = new McpServer({
  name: 'shopify-mcp',
  version: '1.0.0'
});

mcpServer.registerTool(
  'test_connection',
  {
    title: 'Test Connection',
    description: 'Simple MCP connectivity test',
    inputSchema: {
      message: z.string().optional()
    }
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

mcpServer.registerTool(
  'create_primary_product',
  {
    title: 'Create Primary Product',
    description: 'Create Shopify product with Primary rules',
    inputSchema: {
      brand: z.string(),
      productName: z.string(),
      colour: z.string(),
      productType: z.string().optional(),
      category: z.string().optional(),
      model: z.string().optional(),
      descriptionHtml: z.string().optional(),
      tags: z.array(z.string()).optional(),
      sku: z.string(),
      price: z.string(),
      cost: z.string(),
      sizes: z.array(z.string()),
      imageUrls: z.array(z.string()).optional()
    }
  },
  async (input) => {
    const brand = cleanText(input.brand);
    const productName = cleanText(input.productName);
    const colour = cleanText(input.colour);
    const sku = cleanText(input.sku);
    const price = cleanText(input.price);
    const cost = cleanText(input.cost);
    const sizes = normalizeStringArray(input.sizes);
    const imageUrls = normalizeStringArray(input.imageUrls);
    const extraTags = normalizeStringArray(input.tags);

    const title = buildPrimaryTitle(brand, productName, colour);

    const tags = buildPrimaryTags({
      brand,
      productName,
      colour,
      productType: input.productType,
      category: input.category,
      model: input.model,
      tags: extraTags
    });

    const createProduct = await shopifyGraphQL(
      `mutation ($input: ProductCreateInput!) {
        productCreate(product: $input) {
          product { id title }
          userErrors { message }
        }
      }`,
      {
        input: {
          title,
          vendor: brand,
          status: 'DRAFT',
          tags
        }
      }
    );

    const productId = createProduct.productCreate.product.id;

    const variants = sizes.map((size) => ({
      price,
      inventoryItem: {
        sku,
        cost
      },
      optionValues: [{ name: size, optionName: "Size" }]
    }));

    const bulkCreate = await shopifyGraphQL(
      `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants { id title }
        }
      }`,
      {
        productId,
        variants
      }
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            created: true,
            productId,
            variants: bulkCreate.productVariantsBulkCreate.productVariants,
            tags
          })
        }
      ]
    };
  }
);

const transport = new StreamableHTTPServerTransport({
  enableJsonResponse: true
});

await mcpServer.connect(transport);

app.get('/', (_req, res) => {
  res.send('Shopify MCP running');
});

app.all('/mcp', async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

app.listen(process.env.PORT || 3000);

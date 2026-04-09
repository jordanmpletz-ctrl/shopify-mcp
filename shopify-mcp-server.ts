import express from 'express';
import { randomUUID } from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

type JsonMap = Record<string, unknown>;
type ShopifyGraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const PORT = Number(process.env.PORT || 3000);

if (!SHOPIFY_STORE_DOMAIN) {
  throw new Error('Missing SHOPIFY_STORE_DOMAIN');
}

if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
  throw new Error('Missing SHOPIFY_ADMIN_ACCESS_TOKEN');
}

const shopifyEndpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

async function shopifyGraphQL<T>(query: string, variables: JsonMap = {}): Promise<T> {
  const response = await fetch(shopifyEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const json = (await response.json()) as ShopifyGraphQLResponse<T>;

  if (!response.ok) {
    throw new Error(`Shopify HTTP error ${response.status}: ${JSON.stringify(json)}`);
  }

  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  if (!json.data) {
    throw new Error('Shopify returned no data');
  }

  return json.data;
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => cleanText(v)).filter(Boolean))];
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function buildPrimaryTitle(brand: string, productName: string, colour: string): string {
  return `${brand} - ${productName} in ${colour}`;
}

function buildPrimaryTags(input: {
  brand: string;
  productName: string;
  colour: string;
  productType?: string;
  category?: string;
  model?: string;
  tags?: string[];
}): string[] {
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

function buildPrimaryProductPayload(input: {
  brand: string;
  productName: string;
  colour: string;
  productType?: string;
  category?: string;
  model?: string;
  descriptionHtml?: string;
  tags?: string[];
}) {
  const brand = cleanText(input.brand);
  const productName = cleanText(input.productName);
  const colour = cleanText(input.colour);
  const productType = cleanText(input.productType);
  const category = cleanText(input.category);
  const model = cleanText(input.model);
  const descriptionHtml = cleanText(input.descriptionHtml);
  const extraTags = normalizeStringArray(input.tags);

  if (!brand) throw new Error('Missing brand');
  if (!productName) throw new Error('Missing productName');
  if (!colour) throw new Error('Missing colour');

  return {
    title: buildPrimaryTitle(brand, productName, colour),
    vendor: brand,
    productType,
    category,
    colour,
    model,
    descriptionHtml,
    status: 'DRAFT' as const,
    tags: buildPrimaryTags({
      brand,
      productName,
      colour,
      productType,
      category,
      model,
      tags: extraTags
    })
  };
}

function buildVariantPayload(input: {
  sku: string;
  price: string;
  cost: string;
  compareAtPrice?: string;
  sizes: string[];
  imageUrls?: string[];
}) {
  const sku = cleanText(input.sku);
  const price = cleanText(input.price);
  const cost = cleanText(input.cost);
  const compareAtPrice = cleanText(input.compareAtPrice);
  const sizes = normalizeStringArray(input.sizes);
  const imageUrls = normalizeStringArray(input.imageUrls);

  if (!sku) throw new Error('Missing sku');
  if (!price) throw new Error('Missing price');
  if (!cost) throw new Error('Missing cost');
  if (!sizes.length) throw new Error('Missing sizes');

  return {
    sku,
    price,
    cost,
    compareAtPrice: compareAtPrice || undefined,
    sizes,
    imageUrls
  };
}

function buildImageInputs(imageUrls: string[], brand: string) {
  return imageUrls.map((url, index) => ({
    originalSource: url,
    mediaContentType: 'IMAGE' as const,
    alt: `${brand} image ${index + 1}`
  }));
}

const server = new McpServer({
  name: 'primary-shopify-mcp',
  version: '1.0.0',
  instructions:
    'Use these tools to read and create Shopify products for Primary. Default new products to DRAFT. Use title format Brand - Product Name in Colour. Keep the same SKU across all size variants unless the user explicitly asks otherwise.'
});

server.registerTool(
  'shop_info',
  {
    title: 'Shop Info',
    description: 'Get basic information about the connected Shopify store.',
    annotations: { readOnlyHint: true },
    inputSchema: {}
  },
  async () => {
    const data = await shopifyGraphQL<{
      shop: {
        id: string;
        name: string;
        myshopifyDomain: string;
        currencyCode: string;
      };
    }>(`
      query {
        shop {
          id
          name
          myshopifyDomain
          currencyCode
        }
      }
    `);

    return {
      content: [{ type: 'text', text: JSON.stringify(data.shop, null, 2) }]
    };
  }
);

server.registerTool(
  'search_products',
  {
    title: 'Search Products',
    description: 'Search Shopify products by title, tag, handle, vendor, or SKU-like query.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      query: z.string().min(1),
      first: z.number().int().min(1).max(50).default(10)
    }
  },
  async ({ query, first }) => {
    const data = await shopifyGraphQL<{
      products: {
        edges: Array<{
          node: {
            id: string;
            title: string;
            handle: string;
            vendor: string;
            productType: string;
            tags: string[];
            status: string;
            variants: {
              edges: Array<{
                node: {
                  id: string;
                  title: string;
                  sku?: string | null;
                  price?: string | null;
                  inventoryItem?: {
                    unitCost?: { amount?: string | null } | null;
                  } | null;
                };
              }>;
            };
          };
        }>;
      };
    }>(
      `
      query SearchProducts($query: String!, $first: Int!) {
        products(first: $first, query: $query) {
          edges {
            node {
              id
              title
              handle
              vendor
              productType
              tags
              status
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    inventoryItem {
                      unitCost {
                        amount
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      `,
      { query, first }
    );

    const result = data.products.edges.map((edge) => ({
      id: edge.node.id,
      title: edge.node.title,
      handle: edge.node.handle,
      vendor: edge.node.vendor,
      productType: edge.node.productType,
      tags: edge.node.tags,
      status: edge.node.status,
      variants: edge.node.variants.edges.map((variantEdge) => ({
        id: variantEdge.node.id,
        title: variantEdge.node.title,
        sku: variantEdge.node.sku || '',
        price: variantEdge.node.price || '',
        cost: variantEdge.node.inventoryItem?.unitCost?.amount || null
      }))
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }
);

server.registerTool(
  'get_product_by_sku',
  {
    title: 'Get Product By SKU',
    description: 'Find a product variant by SKU and return the matching product and variant details.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      sku: z.string().min(1)
    }
  },
  async ({ sku }) => {
    const data = await shopifyGraphQL<{
      productVariants: {
        edges: Array<{
          node: {
            id: string;
            title: string;
            sku?: string | null;
            price?: string | null;
            inventoryItem?: {
              unitCost?: { amount?: string | null } | null;
            } | null;
            product: {
              id: string;
              title: string;
              handle: string;
              vendor: string;
              productType: string;
              tags: string[];
              status: string;
            };
          };
        }>;
      };
    }>(
      `
      query ProductBySku($query: String!) {
        productVariants(first: 20, query: $query) {
          edges {
            node {
              id
              title
              sku
              price
              inventoryItem {
                unitCost {
                  amount
                }
              }
              product {
                id
                title
                handle
                vendor
                productType
                tags
                status
              }
            }
          }
        }
      }
      `,
      { query: `sku:${sku}` }
    );

    const result = data.productVariants.edges.map((edge) => ({
      variant: {
        id: edge.node.id,
        title: edge.node.title,
        sku: edge.node.sku || '',
        price: edge.node.price || '',
        cost: edge.node.inventoryItem?.unitCost?.amount || null
      },
      product: edge.node.product
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }
);

server.registerTool(
  'preview_primary_product',
  {
    title: 'Preview Primary Product',
    description: 'Preview how a Primary product will be normalized before creating it in Shopify.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      brand: z.string().min(1),
      productName: z.string().min(1),
      colour: z.string().min(1),
      productType: z.string().optional(),
      category: z.string().optional(),
      model: z.string().optional(),
      descriptionHtml: z.string().optional(),
      tags: z.array(z.string()).optional(),
      sku: z.string().min(1),
      price: z.string().min(1),
      cost: z.string().min(1),
      compareAtPrice: z.string().optional(),
      sizes: z.array(z.string()).min(1),
      imageUrls: z.array(z.string()).optional()
    }
  },
  async (input) => {
    const product = buildPrimaryProductPayload(input);
    const variants = buildVariantPayload(input);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              product,
              variants: variants.sizes.map((size) => ({
                size,
                sku: variants.sku,
                price: variants.price,
                cost: variants.cost,
                compareAtPrice: variants.compareAtPrice || null
              })),
              images: variants.imageUrls
            },
            null,
            2
          )
        }
      ]
    };
  }
);

const expressApp = express();
expressApp.use(express.json({ limit: '25mb' }));

expressApp.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Real Shopify MCP server is running',
    mcpEndpoint: '/mcp'
  });
});

expressApp.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const mcpApp = createMcpExpressApp(server, {
  basePath: '/mcp',
  verboseLogs: true,
  transport: (_req) =>
    new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true
    })
});

expressApp.use(mcpApp);

expressApp.listen(PORT, () => {
  console.log(`Real Shopify MCP server running on port ${PORT}`);
});

// shopify-mcp-server.ts
// Real MCP server for Shopify using the official MCP TypeScript SDK over Streamable HTTP.
// Deploy this on Railway and point your MCP client at POST/GET /mcp

import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';

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
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
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
    ...(input.tags || []),
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
      tags: extraTags,
    }),
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
    imageUrls,
  };
}

function buildImageInputs(imageUrls: string[], brand: string): Array<{ originalSource: string; mediaContentType: 'IMAGE'; alt: string }> {
  return imageUrls.map((url, index) => ({
    originalSource: url,
    mediaContentType: 'IMAGE' as const,
    alt: `${brand} image ${index + 1}`,
  }));
}

const server = new McpServer({
  name: 'primary-shopify-mcp',
  version: '1.0.0',
  instructions:
    'Use these tools to read and create Shopify products for Primary. Default new products to DRAFT. Use title format Brand - Product Name in Colour. Keep the same SKU across all size variants unless the user explicitly asks otherwise.',
});

server.registerTool(
  'shop_info',
  {
    title: 'Shop Info',
    description: 'Get basic information about the connected Shopify store.',
    annotations: { readOnlyHint: true },
    inputSchema: {},
  },
  async () => {
    const data = await shopifyGraphQL<{
      shop: { id: string; name: string; myshopifyDomain: string; currencyCode: string };
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
      content: [{ type: 'text', text: JSON.stringify(data.shop, null, 2) }],
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
      first: z.number().int().min(1).max(50).default(10),
    },
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
                  inventoryItem?: { unitCost?: { amount?: string | null } | null } | null;
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
        cost: variantEdge.node.inventoryItem?.unitCost?.amount || null,
      })),
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
      sku: z.string().min(1),
    },
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
            inventoryItem?: { unitCost?: { amount?: string | null } | null } | null;
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
        cost: edge.node.inventoryItem?.unitCost?.amount || null,
      },
      product: edge.node.product,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
      imageUrls: z.array(z.string()).optional(),
    },
  },
  async (input) => {
    const product = buildPrimaryProductPayload(input);
    const variants = buildVariantPayload(input);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          product,
          variants: variants.sizes.map((size) => ({
            size,
            sku: variants.sku,
            price: variants.price,
            cost: variants.cost,
            compareAtPrice: variants.compareAtPrice || null,
          })),
          images: variants.imageUrls,
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  'create_primary_product_full',
  {
    title: 'Create Primary Product Full',
    description: 'Create a Shopify product with Primary naming rules, tags, same-SKU size variants, cost, price, and optional images.',
    annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: false },
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
      imageUrls: z.array(z.string()).optional(),
    },
  },
  async (input) => {
    const productPayload = buildPrimaryProductPayload(input);
    const variantPayload = buildVariantPayload(input);
    const imageInputs = buildImageInputs(variantPayload.imageUrls, productPayload.vendor);

    const createdProductData = await shopifyGraphQL<{
      productCreate: {
        product: { id: string; title: string; handle: string; vendor: string; productType: string; tags: string[]; status: string } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(
      `
      mutation CreateProduct($input: ProductCreateInput!) {
        productCreate(product: $input) {
          product {
            id
            title
            handle
            vendor
            productType
            tags
            status
          }
          userErrors {
            field
            message
          }
        }
      }
      `,
      {
        input: {
          title: productPayload.title,
          vendor: productPayload.vendor,
          productType: productPayload.productType || undefined,
          status: productPayload.status,
          tags: productPayload.tags,
          descriptionHtml: productPayload.descriptionHtml || undefined,
        },
      }
    );

    if (createdProductData.productCreate.userErrors.length) {
      throw new Error(JSON.stringify(createdProductData.productCreate.userErrors));
    }

    const createdProduct = createdProductData.productCreate.product;
    if (!createdProduct) throw new Error('Shopify did not return a created product');

    const optionsCreateData = await shopifyGraphQL<{
      productOptionsCreate: {
        product: { id: string; options: Array<{ id: string; name: string }> } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(
      `
      mutation ProductOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
        productOptionsCreate(productId: $productId, options: $options) {
          product {
            id
            options {
              id
              name
            }
          }
          userErrors {
            field
            message
          }
        }
      }
      `,
      {
        productId: createdProduct.id,
        options: [
          {
            name: 'Size',
            values: variantPayload.sizes.map((size) => ({ name: size })),
          },
        ],
      }
    );

    if (optionsCreateData.productOptionsCreate.userErrors.length) {
      throw new Error(JSON.stringify(optionsCreateData.productOptionsCreate.userErrors));
    }

    const variantsPayload = variantPayload.sizes.map((size) => ({
      optionValues: [{ optionName: 'Size', name: size }],
      price: variantPayload.price,
      compareAtPrice: variantPayload.compareAtPrice || undefined,
      taxable: true,
      inventoryPolicy: 'DENY',
      inventoryItem: {
        sku: variantPayload.sku,
        tracked: true,
        cost: variantPayload.cost,
      },
      mediaSrc: variantPayload.imageUrls.length ? [variantPayload.imageUrls[0]] : undefined,
    }));

    const bulkCreateData = await shopifyGraphQL<{
      productVariantsBulkCreate: {
        product: { id: string; title: string } | null;
        productVariants: Array<{
          id: string;
          title: string;
          price?: string | null;
          compareAtPrice?: string | null;
          inventoryItem?: {
            sku?: string | null;
            unitCost?: { amount?: string | null; currencyCode?: string | null } | null;
          } | null;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(
      `
      mutation BulkCreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $media: [CreateMediaInput!]) {
        productVariantsBulkCreate(productId: $productId, variants: $variants, media: $media, strategy: REMOVE_STANDALONE_VARIANT) {
          product {
            id
            title
          }
          productVariants {
            id
            title
            price
            compareAtPrice
            inventoryItem {
              sku
              unitCost {
                amount
                currencyCode
              }
            }
            selectedOptions {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
      `,
      {
        productId: createdProduct.id,
        variants: variantsPayload,
        media: imageInputs.length ? imageInputs : undefined,
      }
    );

    if (bulkCreateData.productVariantsBulkCreate.userErrors.length) {
      throw new Error(JSON.stringify(bulkCreateData.productVariantsBulkCreate.userErrors));
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          created: true,
          product: createdProduct,
          variants: bulkCreateData.productVariantsBulkCreate.productVariants.map((variant) => ({
            id: variant.id,
            title: variant.title,
            sku: variant.inventoryItem?.sku || '',
            price: variant.price || '',
            cost: variant.inventoryItem?.unitCost?.amount || null,
            compareAtPrice: variant.compareAtPrice || null,
            selectedOptions: variant.selectedOptions,
          })),
          imagesRequested: variantPayload.imageUrls,
        }, null, 2),
      }],
    };
  }
);

const expressApp = express();
expressApp.use(express.json({ limit: '25mb' }));

expressApp.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Real Shopify MCP server is running',
    mcpEndpoint: '/mcp',
  });
});

expressApp.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const mcpApp = createMcpExpressApp(server, {
  basePath: '/mcp',
  verboseLogs: true,
  transport: (_req) =>
    new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    }),
});

expressApp.use(mcpApp);

expressApp.listen(PORT, () => {
  console.log(`Real Shopify MCP server running on port ${PORT}`);
});

/*
package.json
-----------
{
  "name": "primary-shopify-mcp",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node --import tsx shopify-mcp-server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/express": "^1.17.5",
    "@modelcontextprotocol/node": "^1.17.5",
    "@modelcontextprotocol/server": "^1.17.5",
    "express": "^4.21.2",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "tsx": "^4.20.6"
  }
}

Railway variables
-----------------
SHOPIFY_STORE_DOMAIN=primary-skateboards.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=your_token_here
SHOPIFY_API_VERSION=2026-04

Your MCP client should target:
POST/GET https://YOUR-RAILWAY-DOMAIN/mcp
*/

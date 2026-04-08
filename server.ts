import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2026-04';

if (!SHOPIFY_STORE_DOMAIN) {
  throw new Error('Missing SHOPIFY_STORE_DOMAIN');
}

if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
  throw new Error('Missing SHOPIFY_ADMIN_ACCESS_TOKEN');
}

const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

type ShopifyGraphQLError = {
  message: string;
  extensions?: Record<string, unknown>;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
};

type ShopifyResponse<T> = {
  data?: T;
  errors?: ShopifyGraphQLError[];
};

async function shopifyGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as ShopifyResponse<T>;

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${res.statusText} - ${JSON.stringify(json)}`);
  }

  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  if (!json.data) {
    throw new Error('Shopify returned no data');
  }

  return json.data;
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

const server = new McpServer(
  {
    name: 'shopify-mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      logging: {},
    },
  },
);

server.registerTool(
  'shopify_shop_info',
  {
    title: 'Shopify Shop Info',
    description: 'Get basic information about the connected Shopify store.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({}),
  },
  async (_args, ctx) => {
    try {
      await ctx.mcpReq.log('info', 'Fetching Shopify shop info');

      const data = await shopifyGraphQL<{
        shop: {
          id: string;
          name: string;
          myshopifyDomain: string;
          currencyCode: string;
          plan: { displayName: string; partnerDevelopment: boolean } | null;
        };
      }>(`
        query ShopInfo {
          shop {
            id
            name
            myshopifyDomain
            currencyCode
            plan {
              displayName
              partnerDevelopment
            }
          }
        }
      `);

      return textResult(data.shop);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : 'Unknown error');
    }
  },
);

server.registerTool(
  'shopify_search_products',
  {
    title: 'Search Shopify Products',
    description: 'Search products by keyword, title, vendor, tag, handle, or SKU-oriented query string.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      query: z.string().min(1).describe('Shopify product search query, e.g. title:Levi, tag:Denim, sku:39434-0157'),
      first: z.number().int().min(1).max(25).default(10),
    }),
  },
  async ({ query, first }, ctx) => {
    try {
      await ctx.mcpReq.log('info', `Searching Shopify products with query: ${query}`);

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
                    sku: string | null;
                    barcode: string | null;
                    price: string | null;
                    inventoryQuantity: number | null;
                  };
                }>;
              };
            };
          }>;
        };
      }>(`
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
                variants(first: 25) {
                  edges {
                    node {
                      id
                      title
                      sku
                      barcode
                      price
                      inventoryQuantity
                    }
                  }
                }
              }
            }
          }
        }
      `, { query, first });

      const products = data.products.edges.map(({ node }) => ({
        id: node.id,
        title: node.title,
        handle: node.handle,
        vendor: node.vendor,
        productType: node.productType,
        tags: node.tags,
        status: node.status,
        variants: node.variants.edges.map(({ node: variant }) => ({
          id: variant.id,
          title: variant.title,
          sku: variant.sku,
          barcode: variant.barcode,
          price: variant.price,
          inventoryQuantity: variant.inventoryQuantity,
        })),
      }));

      return textResult(products);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : 'Unknown error');
    }
  },
);

server.registerTool(
  'shopify_get_product_by_sku',
  {
    title: 'Get Shopify Product By SKU',
    description: 'Find the first Shopify product variant matching a SKU and return the parent product plus variant details.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      sku: z.string().min(1),
    }),
  },
  async ({ sku }, ctx) => {
    try {
      await ctx.mcpReq.log('info', `Looking up Shopify product by SKU: ${sku}`);

      const data = await shopifyGraphQL<{
        productVariants: {
          edges: Array<{
            node: {
              id: string;
              title: string;
              sku: string | null;
              barcode: string | null;
              price: string | null;
              inventoryQuantity: number | null;
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
      }>(`
        query ProductBySku($query: String!) {
          productVariants(first: 5, query: $query) {
            edges {
              node {
                id
                title
                sku
                barcode
                price
                inventoryQuantity
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
      `, { query: `sku:${sku}` });

      const matches = data.productVariants.edges.map(({ node }) => ({
        variant: {
          id: node.id,
          title: node.title,
          sku: node.sku,
          barcode: node.barcode,
          price: node.price,
          inventoryQuantity: node.inventoryQuantity,
        },
        product: node.product,
      }));

      if (!matches.length) {
        return errorResult(`No product variant found for SKU ${sku}`);
      }

      return textResult(matches);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : 'Unknown error');
    }
  },
);

server.registerTool(
  'shopify_update_product_metadata',
  {
    title: 'Update Shopify Product Metadata',
    description: 'Update title, vendor, product type, tags, description HTML, and status for an existing Shopify product.',
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      productId: z.string().min(1).describe('GraphQL product ID, e.g. gid://shopify/Product/...'),
      title: z.string().optional(),
      vendor: z.string().optional(),
      productType: z.string().optional(),
      tags: z.array(z.string()).optional(),
      descriptionHtml: z.string().optional(),
      status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT']).optional(),
    }),
  },
  async ({ productId, title, vendor, productType, tags, descriptionHtml, status }, ctx) => {
    try {
      await ctx.mcpReq.log('info', `Updating Shopify product metadata for ${productId}`);

      const input: Record<string, unknown> = { id: productId };
      if (title !== undefined) input.title = title;
      if (vendor !== undefined) input.vendor = vendor;
      if (productType !== undefined) input.productType = productType;
      if (tags !== undefined) input.tags = tags;
      if (descriptionHtml !== undefined) input.descriptionHtml = descriptionHtml;
      if (status !== undefined) input.status = status;

      const data = await shopifyGraphQL<{
        productUpdate: {
          product: {
            id: string;
            title: string;
            handle: string;
            vendor: string;
            productType: string;
            tags: string[];
            status: string;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(`
        mutation UpdateProduct($input: ProductUpdateInput!) {
          productUpdate(product: $input) {
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
      `, { input });

      if (data.productUpdate.userErrors.length) {
        return errorResult(JSON.stringify(data.productUpdate.userErrors, null, 2));
      }

      return textResult(data.productUpdate.product);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : 'Unknown error');
    }
  },
);

server.registerTool(
  'shopify_create_product_basic',
  {
    title: 'Create Basic Shopify Product',
    description: 'Create a basic Shopify product shell in DRAFT, ACTIVE, or ARCHIVED status. Good for the first pass before adding variants and media.',
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      title: z.string().min(1),
      vendor: z.string().optional(),
      productType: z.string().optional(),
      tags: z.array(z.string()).default([]),
      descriptionHtml: z.string().optional(),
      status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT']).default('DRAFT'),
    }),
  },
  async ({ title, vendor, productType, tags, descriptionHtml, status }, ctx) => {
    try {
      await ctx.mcpReq.log('info', `Creating Shopify product shell: ${title}`);

      const input: Record<string, unknown> = {
        title,
        status,
        tags,
      };
      if (vendor !== undefined) input.vendor = vendor;
      if (productType !== undefined) input.productType = productType;
      if (descriptionHtml !== undefined) input.descriptionHtml = descriptionHtml;

      const data = await shopifyGraphQL<{
        productCreate: {
          product: {
            id: string;
            title: string;
            handle: string;
            vendor: string;
            productType: string;
            tags: string[];
            status: string;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(`
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
      `, { input });

      if (data.productCreate.userErrors.length) {
        return errorResult(JSON.stringify(data.productCreate.userErrors, null, 2));
      }

      return textResult(data.productCreate.product);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : 'Unknown error');
    }
  },
);

server.registerTool(
  'shopify_set_variant_price',
  {
    title: 'Set Shopify Variant Price',
    description: 'Update the price on a single Shopify product variant.',
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      variantId: z.string().min(1).describe('GraphQL ProductVariant ID'),
      price: z.string().min(1).describe('Price as a string, e.g. 89.99'),
      compareAtPrice: z.string().optional().describe('Leave undefined to keep current compare-at price.'),
    }),
  },
  async ({ variantId, price, compareAtPrice }, ctx) => {
    try {
      await ctx.mcpReq.log('info', `Updating price for variant ${variantId}`);

      const input: Record<string, unknown> = {
        id: variantId,
        price,
      };
      if (compareAtPrice !== undefined) input.compareAtPrice = compareAtPrice;

      const data = await shopifyGraphQL<{
        productVariantUpdate: {
          productVariant: {
            id: string;
            title: string;
            sku: string | null;
            price: string | null;
            compareAtPrice: string | null;
          } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(`
        mutation UpdateVariant($input: ProductVariantInput!) {
          productVariantUpdate(input: $input) {
            productVariant {
              id
              title
              sku
              price
              compareAtPrice
            }
            userErrors {
              field
              message
            }
          }
        }
      `, { input });

      if (data.productVariantUpdate.userErrors.length) {
        return errorResult(JSON.stringify(data.productVariantUpdate.userErrors, null, 2));
      }

      return textResult(data.productVariantUpdate.productVariant);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : 'Unknown error');
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal MCP server error:', error);
  process.exit(1);
});

/*
SETUP
===== 
1) Create a folder and save this file as shopify-mcp-server.ts
2) Add dependencies:
   npm init -y
   npm install @modelcontextprotocol/sdk zod
   npm install -D typescript tsx @types/node
3) Add package.json scripts:
   {
     "type": "module",
     "scripts": {
       "dev": "tsx shopify-mcp-server.ts",
       "start": "node --import tsx shopify-mcp-server.ts"
     }
   }
4) Set environment variables:
   export SHOPIFY_STORE_DOMAIN="your-store.myshopify.com"
   export SHOPIFY_ADMIN_ACCESS_TOKEN="shpat_or_other_valid_admin_token"
   export SHOPIFY_API_VERSION="2026-04"
5) Run locally:
   npm run dev

EXAMPLE MCP CLIENT CONFIG (Claude Desktop style)
===============================================
{
  "mcpServers": {
    "shopify": {
      "command": "node",
      "args": ["--import", "tsx", "/absolute/path/to/shopify-mcp-server.ts"],
      "env": {
        "SHOPIFY_STORE_DOMAIN": "your-store.myshopify.com",
        "SHOPIFY_ADMIN_ACCESS_TOKEN": "your-token",
        "SHOPIFY_API_VERSION": "2026-04"
      }
    }
  }
}

BEST NEXT TOOLS TO ADD
======================
- create product variants in bulk
- set inventory by SKU
- attach media from URLs
- search collections
- publish/unpublish products
- compare incoming invoice lines to existing Shopify catalog
*/

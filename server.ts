import express from 'express';

const app = express();
app.use(express.json({ limit: '10mb' }));

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';
const PORT = process.env.PORT || 3000;

if (!SHOPIFY_STORE_DOMAIN) {
  throw new Error('Missing SHOPIFY_STORE_DOMAIN');
}

if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
  throw new Error('Missing SHOPIFY_ADMIN_ACCESS_TOKEN');
}

const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

async function shopifyGraphQL(query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Error(`Shopify HTTP error ${response.status}: ${JSON.stringify(json)}`);
  }

  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim();
}

function titleCase(input: string): string {
  return input
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      if (word.toUpperCase() === word && word.length > 1) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function buildPrimaryTitle(brand: string, productName: string, colour: string): string {
  return `${brand} - ${productName} in ${colour}`;
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

function buildPrimaryTags(params: {
  brand: string;
  productName: string;
  colour: string;
  productType?: string;
  category?: string;
  model?: string;
}) {
  const tags = [
    params.brand,
    params.productName,
    params.colour,
    params.productType || '',
    params.category || '',
    params.model || '',
  ];

  return uniqueTags(tags);
}

function buildPrimaryProductPayload(body: any) {
  const brand = cleanText(body.brand);
  const productName = cleanText(body.productName);
  const colour = cleanText(body.colour);
  const productType = cleanText(body.productType);
  const category = cleanText(body.category);
  const model = cleanText(body.model);
  const descriptionHtml = cleanText(body.descriptionHtml);
  const vendor = brand;
  const status = 'DRAFT';

  if (!brand) throw new Error('Missing brand');
  if (!productName) throw new Error('Missing productName');
  if (!colour) throw new Error('Missing colour');

  const normalizedBrand = brand;
  const normalizedProductName = productName;
  const normalizedColour = colour;

  const title = buildPrimaryTitle(
    normalizedBrand,
    normalizedProductName,
    normalizedColour
  );

  const tags = buildPrimaryTags({
    brand: normalizedBrand,
    productName: normalizedProductName,
    colour: normalizedColour,
    productType: productType || undefined,
    category: category || undefined,
    model: model || undefined,
  });

  return {
    title,
    vendor,
    productType: productType || '',
    category,
    colour: normalizedColour,
    model,
    tags,
    status,
    descriptionHtml,
  };
}

app.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Shopify MCP bridge is running',
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/shop', async (_req, res) => {
  try {
    const data = await shopifyGraphQL(`
      query {
        shop {
          id
          name
          myshopifyDomain
          currencyCode
        }
      }
    `);

    res.json(data.shop);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/products/search', async (req, res) => {
  try {
    const { query, first = 10 } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Missing query' });
    }

    const data = await shopifyGraphQL(
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
      `,
      { query, first }
    );

    const products = data.products.edges.map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
      handle: edge.node.handle,
      vendor: edge.node.vendor,
      productType: edge.node.productType,
      tags: edge.node.tags,
      status: edge.node.status,
      variants: edge.node.variants.edges.map((variantEdge: any) => ({
        id: variantEdge.node.id,
        title: variantEdge.node.title,
        sku: variantEdge.node.sku,
        barcode: variantEdge.node.barcode,
        price: variantEdge.node.price,
        inventoryQuantity: variantEdge.node.inventoryQuantity,
      })),
    }));

    res.json(products);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/products/by-sku', async (req, res) => {
  try {
    const { sku } = req.body;

    if (!sku) {
      return res.status(400).json({ error: 'Missing sku' });
    }

    const data = await shopifyGraphQL(
      `
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
      `,
      { query: `sku:${sku}` }
    );

    const matches = data.productVariants.edges.map((edge: any) => ({
      variant: {
        id: edge.node.id,
        title: edge.node.title,
        sku: edge.node.sku,
        barcode: edge.node.barcode,
        price: edge.node.price,
        inventoryQuantity: edge.node.inventoryQuantity,
      },
      product: edge.node.product,
    }));

    res.json(matches);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/products/preview-primary', async (req, res) => {
  try {
    const payload = buildPrimaryProductPayload(req.body);

    res.json({
      previewOnly: true,
      rulesApplied: {
        titleFormat: 'Brand - Product Name in Colour',
        draftByDefault: true,
        tagsIncluded: ['brand', 'productName', 'colour', 'productType', 'category', 'model'],
      },
      product: payload,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/products/create-primary', async (req, res) => {
  try {
    const payload = buildPrimaryProductPayload(req.body);

    const input: Record<string, unknown> = {
      title: payload.title,
      vendor: payload.vendor,
      status: payload.status,
      tags: payload.tags,
    };

    if (payload.productType) input.productType = payload.productType;
    if (payload.descriptionHtml) input.descriptionHtml = payload.descriptionHtml;

    const data = await shopifyGraphQL(
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
      { input }
    );

    if (data.productCreate.userErrors.length > 0) {
      return res.status(400).json({
        errors: data.productCreate.userErrors,
      });
    }

    res.json({
      created: true,
      rulesApplied: {
        titleFormat: 'Brand - Product Name in Colour',
        draftByDefault: true,
        tagsApplied: payload.tags,
      },
      product: data.productCreate.product,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/products/update', async (req, res) => {
  try {
    const {
      productId,
      title,
      vendor,
      productType,
      tags,
      descriptionHtml,
      status,
    } = req.body;

    if (!productId) {
      return res.status(400).json({ error: 'Missing productId' });
    }

    const input: Record<string, unknown> = { id: productId };

    if (title !== undefined) input.title = title;
    if (vendor !== undefined) input.vendor = vendor;
    if (productType !== undefined) input.productType = productType;
    if (tags !== undefined) input.tags = tags;
    if (descriptionHtml !== undefined) input.descriptionHtml = descriptionHtml;
    if (status !== undefined) input.status = status;

    const data = await shopifyGraphQL(
      `
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
      `,
      { input }
    );

    if (data.productUpdate.userErrors.length > 0) {
      return res.status(400).json({ errors: data.productUpdate.userErrors });
    }

    res.json(data.productUpdate.product);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/variants/update-price', async (req, res) => {
  try {
    const { variantId, price, compareAtPrice } = req.body;

    if (!variantId || !price) {
      return res.status(400).json({ error: 'Missing variantId or price' });
    }

    const input: Record<string, unknown> = {
      id: variantId,
      price,
    };

    if (compareAtPrice !== undefined) {
      input.compareAtPrice = compareAtPrice;
    }

    const data = await shopifyGraphQL(
      `
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
      `,
      { input }
    );

    if (data.productVariantUpdate.userErrors.length > 0) {
      return res.status(400).json({ errors: data.productVariantUpdate.userErrors });
    }

    res.json(data.productVariantUpdate.productVariant);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

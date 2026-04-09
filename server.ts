import express from 'express';

type JsonMap = Record<string, unknown>;

type ProductRulesInput = {
  brand: string;
  productName: string;
  colour: string;
  productType?: string;
  category?: string;
  model?: string;
  descriptionHtml?: string;
  tags?: string[];
};

type VariantRulesInput = {
  sku: string;
  price: string;
  cost: string;
  compareAtPrice?: string;
  sizes: string[];
  imageUrls?: string[];
};

type ImageInput = {
  url: string;
  alt?: string;
};

const app = express();
app.use(express.json({ limit: '25mb' }));

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

const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

async function shopifyGraphQL<T>(query: string, variables: JsonMap = {}): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

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
  return [...new Set(value.map((item) => cleanText(item)).filter(Boolean))];
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function buildPrimaryTitle(brand: string, productName: string, colour: string): string {
  return `${brand} - ${productName} in ${colour}`;
}

function buildPrimaryTags(input: ProductRulesInput): string[] {
  const baseTags = [
    input.brand,
    input.productName,
    input.colour,
    input.productType || '',
    input.category || '',
    input.model || '',
    ...normalizeStringArray(input.tags || []),
  ];

  return uniqueTags(baseTags);
}

function buildPrimaryProductPayload(body: any) {
  const brand = cleanText(body.brand);
  const productName = cleanText(body.productName);
  const colour = cleanText(body.colour);
  const productType = cleanText(body.productType);
  const category = cleanText(body.category);
  const model = cleanText(body.model);
  const descriptionHtml = cleanText(body.descriptionHtml);
  const extraTags = normalizeStringArray(body.tags);

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
      descriptionHtml,
      tags: extraTags,
    }),
  };
}

function buildPrimaryVariantPayload(body: any): VariantRulesInput {
  const sku = cleanText(body.sku);
  const price = cleanText(body.price);
  const cost = cleanText(body.cost);
  const compareAtPrice = cleanText(body.compareAtPrice);
  const sizes = normalizeStringArray(body.sizes);
  const imageUrls = normalizeStringArray(body.imageUrls);

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

function buildImageInputs(body: any): ImageInput[] {
  const imageUrls = normalizeStringArray(body.imageUrls);
  return imageUrls.map((url, index) => ({
    url,
    alt: cleanText(body.imageAltTexts?.[index]) || `${cleanText(body.brand) || 'Product'} image ${index + 1}`,
  }));
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

    res.json(data.shop);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/products/search', async (req, res) => {
  try {
    const query = cleanText(req.body.query);
    const first = Number(req.body.first || 10);

    if (!query) {
      return res.status(400).json({ error: 'Missing query' });
    }

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
            media: {
              edges: Array<{
                node: {
                  id: string;
                  alt?: string | null;
                  preview?: {
                    image?: {
                      url?: string | null;
                    } | null;
                  } | null;
                };
              }>;
            };
            variants: {
              edges: Array<{
                node: {
                  id: string;
                  title: string;
                  sku?: string | null;
                  price?: string | null;
                  inventoryItem?: {
                    unitCost?: {
                      amount?: string | null;
                    } | null;
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
              media(first: 20) {
                edges {
                  node {
                    ... on MediaImage {
                      id
                      alt
                      preview {
                        image {
                          url
                        }
                      }
                    }
                  }
                }
              }
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

    res.json(
      data.products.edges.map((edge) => ({
        id: edge.node.id,
        title: edge.node.title,
        handle: edge.node.handle,
        vendor: edge.node.vendor,
        productType: edge.node.productType,
        tags: edge.node.tags,
        status: edge.node.status,
        images: edge.node.media.edges.map((mediaEdge) => ({
          id: mediaEdge.node.id,
          alt: mediaEdge.node.alt || '',
          url: mediaEdge.node.preview?.image?.url || '',
        })),
        variants: edge.node.variants.edges.map((variantEdge) => ({
          id: variantEdge.node.id,
          title: variantEdge.node.title,
          sku: variantEdge.node.sku || '',
          price: variantEdge.node.price || '',
          cost: variantEdge.node.inventoryItem?.unitCost?.amount || null,
        })),
      }))
    );
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/products/by-sku', async (req, res) => {
  try {
    const sku = cleanText(req.body.sku);

    if (!sku) {
      return res.status(400).json({ error: 'Missing sku' });
    }

    const data = await shopifyGraphQL<{
      productVariants: {
        edges: Array<{
          node: {
            id: string;
            title: string;
            sku?: string | null;
            price?: string | null;
            inventoryItem?: {
              unitCost?: {
                amount?: string | null;
              } | null;
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

    res.json(
      data.productVariants.edges.map((edge) => ({
        variant: {
          id: edge.node.id,
          title: edge.node.title,
          sku: edge.node.sku || '',
          price: edge.node.price || '',
          cost: edge.node.inventoryItem?.unitCost?.amount || null,
        },
        product: edge.node.product,
      }))
    );
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/products/create-primary-full', async (req, res) => {
  try {
    const productPayload = buildPrimaryProductPayload(req.body);
    const variantPayload = buildPrimaryVariantPayload(req.body);
    const imageInputs = buildImageInputs(req.body);

    const createProductData = await shopifyGraphQL<{
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

    if (createProductData.productCreate.userErrors.length) {
      return res.status(400).json({
        stage: 'productCreate',
        errors: createProductData.productCreate.userErrors,
      });
    }

    const createdProduct = createProductData.productCreate.product;

    if (!createdProduct) {
      throw new Error('Product was not returned from Shopify');
    }

    const optionsCreateData = await shopifyGraphQL<{
      productOptionsCreate: {
        product: {
          id: string;
          options: Array<{ id: string; name: string }>;
        } | null;
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
      return res.status(400).json({
        stage: 'productOptionsCreate',
        errors: optionsCreateData.productOptionsCreate.userErrors,
        product: createdProduct,
      });
    }

    const mediaPayload = imageInputs.map((image) => ({
      originalSource: image.url,
      mediaContentType: 'IMAGE',
      alt: image.alt || undefined,
    }));

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
        product: {
          id: string;
          title: string;
        } | null;
        productVariants: Array<{
          id: string;
          title: string;
          price?: string | null;
          compareAtPrice?: string | null;
          inventoryItem?: {
            sku?: string | null;
            unitCost?: {
              amount?: string | null;
              currencyCode?: string | null;
            } | null;
          } | null;
          selectedOptions: Array<{ name: string; value: string }>;
        }>;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(
      `
      mutation BulkCreateVariants(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
        $media: [CreateMediaInput!]
      ) {
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
        media: mediaPayload.length ? mediaPayload : undefined,
      }
    );

    if (bulkCreateData.productVariantsBulkCreate.userErrors.length) {
      return res.status(400).json({
        stage: 'productVariantsBulkCreate',
        errors: bulkCreateData.productVariantsBulkCreate.userErrors,
        product: createdProduct,
      });
    }

    let addedMedia: Array<{ alt?: string | null; status?: string | null; previewUrl?: string | null }> = [];

    if (imageInputs.length > 1) {
      const extraImages = imageInputs.slice(1).map((image) => ({
        originalSource: image.url,
        mediaContentType: 'IMAGE',
        alt: image.alt || undefined,
      }));

      const mediaData = await shopifyGraphQL<{
        productCreateMedia: {
          media: Array<{
            alt?: string | null;
            status?: string | null;
            preview?: {
              image?: {
                url?: string | null;
              } | null;
            } | null;
          }>;
          mediaUserErrors: Array<{ field?: string[] | null; message: string }>;
        };
      }>(
        `
        mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media {
              ... on MediaImage {
                alt
                status
                preview {
                  image {
                    url
                  }
                }
              }
            }
            mediaUserErrors {
              field
              message
            }
          }
        }
        `,
        {
          productId: createdProduct.id,
          media: extraImages,
        }
      );

      if (mediaData.productCreateMedia.mediaUserErrors.length) {
        return res.status(400).json({
          stage: 'productCreateMedia',
          errors: mediaData.productCreateMedia.mediaUserErrors,
          product: createdProduct,
          variants: bulkCreateData.productVariantsBulkCreate.productVariants,
        });
      }

      addedMedia = mediaData.productCreateMedia.media.map((media) => ({
        alt: media.alt || null,
        status: media.status || null,
        previewUrl: media.preview?.image?.url || null,
      }));
    }

    res.json({
      created: true,
      rulesApplied: {
        titleFormat: 'Brand - Product Name in Colour',
        draftByDefault: true,
        sameSkuAcrossVariants: true,
        costIncluded: true,
        imagesAttachedInGivenOrder: true,
      },
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
      images: {
        requested: imageInputs,
        attachedExtraMedia: addedMedia,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/test-primary-preview', (_req, res) => {
  try {
    const payload = buildPrimaryProductPayload({
      brand: "Levi's",
      productName: '469 Loose Shorts',
      colour: 'Vintage Story',
      productType: 'Shorts',
      category: 'Apparel',
      model: '469',
      descriptionHtml: '<p>Test product preview</p>',
    });

    res.json({
      previewOnly: true,
      product: payload,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/test-primary-variants-preview', (_req, res) => {
  try {
    const productPayload = buildPrimaryProductPayload({
      brand: "Levi's",
      productName: '469 Loose Shorts',
      colour: 'Vintage Story',
      productType: 'Shorts',
      category: 'Apparel',
      model: '469',
      descriptionHtml: '<p>Test product preview</p>',
    });

    const variantPayload = buildPrimaryVariantPayload({
      sku: '39434-0157',
      price: '88.00',
      cost: '44.00',
      sizes: ['30', '31', '32', '33', '34'],
      imageUrls: [
        'https://example.com/main-white-background.jpg',
        'https://example.com/model-1.jpg',
        'https://example.com/model-2.jpg',
      ],
    });

    res.json({
      previewOnly: true,
      product: productPayload,
      variants: variantPayload.sizes.map((size) => ({
        size,
        sku: variantPayload.sku,
        price: variantPayload.price,
        cost: variantPayload.cost,
      })),
      images: variantPayload.imageUrls,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

import { removeEdgesAndNodes } from '@bigcommerce/catalyst-client';
import { cache } from 'react';
import { z } from 'zod';

import { getSessionCustomerAccessToken } from '~/auth';
import { client } from '~/client';
import { facetedHawkSearch } from '~/client/faceted-hawksearch';
import { PaginationFragment } from '~/client/fragments/pagination';
import { graphql, VariablesOf } from '~/client/graphql';
import { hawksearchDebug, isHawksearchEnabled } from '~/client/hawksearch';
import { revalidate } from '~/client/revalidate-target';
import { ProductCardFragment } from '~/components/product-card/fragment';

const GetProductSearchResultsQuery = graphql(
  `
    query GetProductSearchResultsQuery(
      $first: Int
      $last: Int
      $after: String
      $before: String
      $filters: SearchProductsFiltersInput!
      $sort: SearchProductsSortInput
    ) {
      site {
        search {
          searchProducts(filters: $filters, sort: $sort) {
            products(first: $first, after: $after, last: $last, before: $before) {
              pageInfo {
                ...PaginationFragment
              }
              collectionInfo {
                totalItems
              }
              edges {
                node {
                  ...ProductCardFragment
                }
              }
            }
            filters {
              edges {
                node {
                  __typename
                  name
                  isCollapsedByDefault
                  ... on BrandSearchFilter {
                    displayProductCount
                    brands {
                      pageInfo {
                        ...PaginationFragment
                      }
                      edges {
                        cursor
                        node {
                          entityId
                          name
                          isSelected
                          productCount
                        }
                      }
                    }
                  }
                  ... on CategorySearchFilter {
                    displayProductCount
                    categories {
                      pageInfo {
                        ...PaginationFragment
                      }
                      edges {
                        cursor
                        node {
                          entityId
                          name
                          isSelected
                          productCount
                          subCategories {
                            pageInfo {
                              ...PaginationFragment
                            }
                            edges {
                              cursor
                              node {
                                entityId
                                name
                                isSelected
                                productCount
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                  ... on ProductAttributeSearchFilter {
                    displayProductCount
                    filterName
                    attributes {
                      pageInfo {
                        ...PaginationFragment
                      }
                      edges {
                        cursor
                        node {
                          value
                          isSelected
                          productCount
                        }
                      }
                    }
                  }
                  ... on RatingSearchFilter {
                    ratings {
                      pageInfo {
                        ...PaginationFragment
                      }
                      edges {
                        cursor
                        node {
                          value
                          isSelected
                          productCount
                        }
                      }
                    }
                  }
                  ... on PriceSearchFilter {
                    selected {
                      minPrice
                      maxPrice
                    }
                  }
                  ... on OtherSearchFilter {
                    displayProductCount
                    freeShipping {
                      isSelected
                      productCount
                    }
                    isFeatured {
                      isSelected
                      productCount
                    }
                    isInStock {
                      isSelected
                      productCount
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
  [PaginationFragment, ProductCardFragment],
);

const GetCategoryForHawksearchQuery = graphql(`
  query GetCategoryForHawksearch($entityId: Int!) {
    site {
      category(entityId: $entityId) {
        entityId
        name
        path
        breadcrumbs(depth: 5) {
          edges {
            node {
              name
              path
            }
          }
        }
      }
    }
  }
`);

type Variables = VariablesOf<typeof GetProductSearchResultsQuery>;
type SearchProductsSortInput = Variables['sort'];
type SearchProductsFiltersInput = Variables['filters'];

interface ProductSearch {
  limit?: number;
  before?: string;
  after?: string;
  sort?: SearchProductsSortInput;
  filters: SearchProductsFiltersInput;
}

const getCategoryFilterValues = cache(async (entityId: number) => {
  const response = await client.fetch({
    document: GetCategoryForHawksearchQuery,
    variables: { entityId },
    fetchOptions: { next: { revalidate: 300 } },
  });

  const category = response.data.site.category;

  if (!category) {
    return [entityId.toString()];
  }

  const breadcrumbEdges = category.breadcrumbs.edges ?? [];
  const breadcrumbs = breadcrumbEdges
    .map((edge) => edge.node.name)
    .filter((name) => name.trim() !== '');

  const breadcrumbPath = breadcrumbs.length > 0 ? breadcrumbs.join('|') : undefined;
  const path = category.path.trim();
  const slug =
    path !== ''
      ? path
          .replace(/^\/+|\/+$/g, '')
          .split('/')
          .filter(Boolean)
          .at(-1)
      : undefined;

  return [entityId.toString(), category.name, breadcrumbPath, path, slug].filter(
    (value): value is string => Boolean(value && value.trim() !== ''),
  );
});

const getStorefrontProductSearchResults = async (
  { limit = 9, after, before, sort, filters }: ProductSearch,
  customerAccessToken?: string,
) => {
  hawksearchDebug('fetch-faceted-search using storefront api', {
    limit,
    after,
    before,
    sort,
    filters,
  });

  const filterArgs = { filters, sort };
  const paginationArgs = before ? { last: limit, before } : { first: limit, after };

  const response = await client.fetch({
    document: GetProductSearchResultsQuery,
    variables: { ...filterArgs, ...paginationArgs },
    customerAccessToken,
    fetchOptions: customerAccessToken ? { cache: 'no-store' } : { next: { revalidate: 300 } },
  });

  const { site } = response.data;
  const searchResults = site.search.searchProducts;
  const items = removeEdgesAndNodes(searchResults.products).map((product) => ({
    ...product,
    fetchOptions: { next: { revalidate } },
  }));

  return {
    facets: {
      items: removeEdgesAndNodes(searchResults.filters).map((node) => {
        switch (node.__typename) {
          case 'BrandSearchFilter':
            return {
              ...node,
              brands: removeEdgesAndNodes(node.brands),
            };

          case 'CategorySearchFilter':
            return {
              ...node,
              categories: removeEdgesAndNodes(node.categories),
            };

          case 'ProductAttributeSearchFilter':
            return {
              ...node,
              attributes: removeEdgesAndNodes(node.attributes),
            };

          case 'RatingSearchFilter':
            return {
              ...node,
              ratings: removeEdgesAndNodes(node.ratings),
            };

          default:
            return node;
        }
      }),
    },
    products: {
      collectionInfo: searchResults.products.collectionInfo,
      pageInfo: searchResults.products.pageInfo,
      items,
    },
  };
};

const getProductSearchResults = cache(
  async ({ limit = 9, after, before, sort, filters }: ProductSearch) => {
    if (isHawksearchEnabled()) {
      const categoryFilterValues =
        filters.categoryEntityId != null
          ? await getCategoryFilterValues(filters.categoryEntityId)
          : undefined;

      if (categoryFilterValues) {
        hawksearchDebug('category filter values', {
          entityId: filters.categoryEntityId,
          values: categoryFilterValues,
        });
      }

      hawksearchDebug('fetch-faceted-search using hawksearch', {
        limit,
        after,
        before,
        sort,
        filters,
      });

      return (await facetedHawkSearch({
        limit,
        after,
        before,
        sort: sort ?? undefined,
        filters,
        categoryFilterValues,
      })) as Awaited<ReturnType<typeof getStorefrontProductSearchResults>>;
    }

    const customerAccessToken = await getSessionCustomerAccessToken();
    return getStorefrontProductSearchResults(
      {
        limit,
        after,
        before,
        sort,
        filters,
      },
      customerAccessToken ?? undefined,
    );
  },
);

const SearchParamSchema = z.union([z.string(), z.array(z.string()), z.undefined()]);

const SearchParamToArray = SearchParamSchema.transform((value) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string' && value !== '') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }

  return undefined;
});

const PrivateSortParam = z.union([
  z.literal('A_TO_Z'),
  z.literal('BEST_REVIEWED'),
  z.literal('BEST_SELLING'),
  z.literal('FEATURED'),
  z.literal('HIGHEST_PRICE'),
  z.literal('LOWEST_PRICE'),
  z.literal('NEWEST'),
  z.literal('RELEVANCE'),
  z.literal('Z_TO_A'),
]) satisfies z.ZodType<SearchProductsSortInput>;

const PublicSortParam = z.string().toUpperCase().pipe(PrivateSortParam);

const SearchProductsFiltersInputSchema = z.object({
  brandEntityIds: z.array(z.number()).optional(),
  categoryEntityId: z.number().optional(),
  categoryEntityIds: z.array(z.number()).optional(),
  hideOutOfStock: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  isFreeShipping: z.boolean().optional(),
  price: z
    .object({
      maxPrice: z.number().optional(),
      minPrice: z.number().optional(),
    })
    .optional(),
  productAttributes: z
    .array(
      z.object({
        attribute: z.string(),
        values: z.array(z.string()),
      }),
    )
    .optional(),
  rating: z
    .object({
      maxRating: z.number().optional(),
      minRating: z.number().optional(),
    })
    .optional(),
  searchSubCategories: z.boolean().optional(),
  searchTerm: z.string().optional(),
}) satisfies z.ZodType<SearchProductsFiltersInput>;

const PrivateSearchParamsSchema = z.object({
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().optional(),
  sort: PrivateSortParam.optional(),
  filters: SearchProductsFiltersInputSchema,
});

export const PublicSearchParamsSchema = z.object({
  after: z.string().optional(),
  before: z.string().optional(),
  brand: SearchParamToArray.transform((value) =>
    value?.map(Number).filter((n) => !Number.isNaN(n)),
  ),
  category: z.coerce.number().optional(),
  categoryIn: SearchParamToArray.transform((value) =>
    value?.map(Number).filter((n) => !Number.isNaN(n)),
  ),
  isFeatured: z.coerce.boolean().optional(),
  limit: z.coerce.number().optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  minRating: z.coerce.number().optional(),
  maxRating: z.coerce.number().optional(),
  sort: PublicSortParam.optional(),
  // In the future we should support more stock filters, e.g. out of stock, low stock, etc.
  stock: SearchParamToArray.transform((value) =>
    value?.filter((stock) => z.enum(['in_stock']).safeParse(stock).success),
  ),
  // In the future we should support more shipping filters, e.g. 2 day shipping, same day, etc.
  shipping: SearchParamToArray.transform((value) =>
    value?.filter((stock) => z.enum(['free_shipping']).safeParse(stock).success),
  ),
  term: z.string().optional(),
  query: z.string().optional(),
  q: z.string().optional(),
});

const AttributeKey = z.custom<`attr_${string}`>((val) => {
  return typeof val === 'string' ? /^attr_.+$/.test(val) : false;
});

const PublicToPrivateParams = PublicSearchParamsSchema.catchall(SearchParamToArray)
  .transform((publicParams) => {
    const { after, before, limit, sort, ...filters } = publicParams;

    const {
      brand,
      category,
      categoryIn,
      isFeatured,
      minPrice,
      maxPrice,
      minRating,
      maxRating,
      term,
      query,
      q,
      shipping,
      stock,
      // There is a bug in Next.js that is adding the path params to the searchParams. We need to filter out the slug params for now.
      // https://github.com/vercel/next.js/issues/51802
      slug,
      ...additionalParams
    } = filters;

    // Assuming the rest of the params are product attributes for now. We need to see if we can get the GQL endpoint to ingore unknown params.
    const productAttributes = Object.entries(additionalParams)
      .filter(([attribute]) => AttributeKey.safeParse(attribute).success)
      .filter(([, values]) => values != null)
      .map(([attribute, values]) => ({
        attribute: attribute.replace('attr_', ''),
        values,
      }));

    const resolvedTerm = term ?? query ?? q;

    return {
      after,
      before,
      limit,
      sort,
      filters: {
        brandEntityIds: brand,
        categoryEntityId: category,
        categoryEntityIds: categoryIn,
        hideOutOfStock: stock?.includes('in_stock'),
        isFreeShipping: shipping?.includes('free_shipping'),
        isFeatured,
        price:
          minPrice || maxPrice
            ? {
                maxPrice,
                minPrice,
              }
            : undefined,
        productAttributes,
        rating:
          minRating || maxRating
            ? {
                maxRating,
                minRating,
              }
            : undefined,
        searchTerm: resolvedTerm,
      },
    };
  })
  .pipe(PrivateSearchParamsSchema);

export const fetchFacetedSearch = cache(
  // We need to make sure the reference passed into this function is the same if we want it to be memoized.
  async (params: z.input<typeof PublicSearchParamsSchema>) => {
    const { after, before, limit = 9, sort, filters } = PublicToPrivateParams.parse(params);

    return getProductSearchResults({
      after,
      before,
      limit,
      sort,
      filters,
    });
  },
);

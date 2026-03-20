import type { ResultOf } from 'gql.tada';
import { cache } from 'react';

import type { ProductCardFragment } from '~/components/product-card/fragment';
import { client } from '~/client';
import { graphql } from '~/client/graphql';
import { revalidate } from '~/client/revalidate-target';

import {
  HawksearchFacet,
  HawksearchFacetValue,
  buildHawksearchPayloads,
  buildProductCard,
  hawksearchDebug,
  runHawksearchSearch,
} from './hawksearch';

interface HawksearchFilters {
  searchTerm?: string | null;
  categoryEntityId?: number | null;
  categoryEntityIds?: number[] | null;
  brandEntityIds?: number[] | null;
  price?: {
    minPrice?: number | null;
    maxPrice?: number | null;
  } | null;
  productAttributes?: Array<{
    attribute: string;
    values: string[];
  }> | null;
  rating?: {
    minRating?: number | null;
    maxRating?: number | null;
  } | null;
}

interface FacetedHawksearchOptions {
  limit?: number | null;
  before?: string | null;
  after?: string | null;
  sort?: string | null;
  filters: HawksearchFilters;
  currencyCode?: string;
  categoryFilterValues?: string[];
}

const DEFAULT_FACET_KEYS = {
  category: 'category',
  brand: 'brand',
  price: 'price_retail',
  rating: 'rating',
};

const CategoryTreeQuery = graphql(`
  query CategoryTreeQuery {
    site {
      categoryTree {
        entityId
        name
        path
        productCount
        children {
          entityId
          name
          path
          productCount
          children {
            entityId
            name
            path
            productCount
          }
        }
      }
    }
  }
`);

const getCategoryTree = cache(async () => {
  const response = await client.fetch({
    document: CategoryTreeQuery,
    fetchOptions: { next: { revalidate } },
  });

  return response.data.site.categoryTree;
});

type CategoryTreeItem = Awaited<ReturnType<typeof getCategoryTree>>[number];
type CategoryNode = {
  entityId: number;
  name: string;
  path: string;
  productCount: number;
  children?: CategoryNode[];
};

const normalizeCategoryValue = (value: string) => {
  const sanitized = value.replace(/%c%[-_]?/gi, '|');
  let decoded = sanitized;

  try {
    decoded = decodeURIComponent(sanitized);
  } catch {
    decoded = sanitized;
  }

  const normalized = decoded
    .replace(/\+/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/[>/]/g, '|')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const cleanPart = (part: string) =>
    part.trim().replace(/^[-_]+/, '').replace(/[-_]+$/, '');

  if (normalized.includes('|')) {
    return normalized
      .split('|')
      .map(cleanPart)
      .filter(Boolean)
      .join('|');
  }

  return cleanPart(normalized);
};

const buildCategoryValueIndex = (items: CategoryTreeItem[]) => {
  const index = new Map<string, number>();

  const walk = (node: CategoryNode, ancestors: string[]) => {
    const rawPath = node.path?.trim() ?? '';
    const path = rawPath.replace(/\/+$/, '');
    const slug = path.split('/').filter(Boolean).at(-1) ?? '';
    const breadcrumbPath = [...ancestors, node.name].join('|');
    const keys = [
      node.entityId.toString(),
      node.name,
      path,
      slug,
      breadcrumbPath,
    ].map(normalizeCategoryValue);

    keys.forEach((key) => {
      if (key && !index.has(key)) {
        index.set(key, node.entityId);
      }
    });

    node.children?.forEach((child) => walk(child, [...ancestors, node.name]));
  };

  items.forEach((item) => walk(item, []));

  return index;
};

const getCategoryValueIndex = cache(async () => {
  const tree = await getCategoryTree();

  return buildCategoryValueIndex(tree);
});

const getFacetKeys = () => {
  const raw = process.env.HAWKSEARCH_FACET_KEYS;

  if (!raw) {
    return DEFAULT_FACET_KEYS;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_FACET_KEYS>;

    return { ...DEFAULT_FACET_KEYS, ...parsed };
  } catch {
    return DEFAULT_FACET_KEYS;
  }
};

const normalizeFilterKey = (value: string) => value.trim();

const toNumber = (value?: string) => {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
};

const normalizeFacetDisplayName = (facet: HawksearchFacet) =>
  facet.DisplayName?.trim() || facet.Name;

const hashString = (value: string) => {
  let hash = 5381;

  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) + hash + value.charCodeAt(i);
  }

  return Math.abs(hash);
};

const toStableEntityId = (facetKey: string, value: string, fallbackIndex: number) => {
  const normalized = normalizeCategoryValue(value);

  if (normalized === '') {
    return fallbackIndex + 1;
  }

  const hashed = hashString(`${facetKey}:${normalized}`);

  return hashed > 0 ? hashed : fallbackIndex + 1;
};

const resolveCategoryEntityId = (
  value: HawksearchFacetValue,
  categoryValueIndex: Map<string, number> | null,
  facetKey: string,
  fallbackIndex: number,
) => {
  const rawValue = (value.Value ?? value.Label ?? '').trim();
  const numeric = toNumber(rawValue);

  if (numeric != null) {
    return numeric;
  }

  const mapped =
    categoryValueIndex?.get(normalizeCategoryValue(rawValue)) ??
    categoryValueIndex?.get(normalizeCategoryValue(value.Label ?? ''));

  if (mapped != null) {
    return mapped;
  }

  return toStableEntityId(facetKey, rawValue, fallbackIndex);
};

const resolveBrandEntityId = (
  value: HawksearchFacetValue,
  facetKey: string,
  fallbackIndex: number,
) => {
  const rawValue = (value.Value ?? value.Label ?? '').trim();
  const numeric = toNumber(rawValue);

  if (numeric != null) {
    return numeric;
  }

  return toStableEntityId(facetKey, rawValue, fallbackIndex);
};

const buildFacetSelections = (
  filters: HawksearchFilters,
  categoryFilterValues?: string[],
) => {
  const selections: Record<string, string[]> = {};
  const facetKeys = getFacetKeys();

  // Build category selections - prioritize user selections over category context
  const categorySelections: string[] = [];

  // If user has selected specific categories via checkboxes, use ONLY those
  if (filters.categoryEntityIds && filters.categoryEntityIds.length > 0) {
    const mappedIds = filters.categoryEntityIds.map(
      (id) => entityIdToValueMap.get(`${facetKeys.category}:${id}`) ?? id.toString(),
    );

    categorySelections.push(...mappedIds);
  } else {
    // No user selections - use parent category context for browsing
    if (categoryFilterValues && categoryFilterValues.length > 0) {
      categorySelections.push(...categoryFilterValues);
    }

    if (filters.categoryEntityId != null) {
      // Map numeric entityId back to original HawkSearch string value
      const originalValue =
        entityIdToValueMap.get(`${facetKeys.category}:${filters.categoryEntityId}`) ??
        filters.categoryEntityId.toString();

      categorySelections.push(originalValue);
    }
  }

  // Set category selections if any exist
  if (categorySelections.length > 0) {
    selections[facetKeys.category] = categorySelections;
  }

  hawksearchDebug('buildFacetSelections - category mapping', {
    categoryFilterValues,
    categoryEntityId: filters.categoryEntityId,
    categoryEntityIds: filters.categoryEntityIds,
    categorySelections,
    entityIdToValueMapEntries: Array.from(entityIdToValueMap.entries()).filter(([key]) =>
      key.startsWith(`${facetKeys.category}:`),
    ),
  });

  if (filters.brandEntityIds && filters.brandEntityIds.length > 0) {
    // Map numeric entityIds back to original HawkSearch string values
    selections[facetKeys.brand] = filters.brandEntityIds.map(
      (id) => entityIdToValueMap.get(`${facetKeys.brand}:${id}`) ?? id.toString(),
    );
  }

  if (filters.price?.minPrice != null || filters.price?.maxPrice != null) {
    const min = filters.price?.minPrice ?? 0;
    const max = filters.price?.maxPrice ?? '';

    selections[facetKeys.price] = [`${min},${max}`];
  }

  if (filters.productAttributes) {
    filters.productAttributes.forEach((attribute) => {
      if (attribute.values.length > 0) {
        selections[attribute.attribute] = attribute.values;
      }
    });
  }

  if (filters.rating?.minRating != null) {
    selections[facetKeys.rating] = [
      `${filters.rating.minRating},${filters.rating.maxRating ?? ''}`,
    ];
  }

  return selections;
};

const toFacetValues = (facet: HawksearchFacet) => facet.Values ?? [];

// Store mapping between numeric entityIds and original HawkSearch string values
const entityIdToValueMap = new Map<string, string>();

const mapCategoryFacetValues = (
  values: HawksearchFacetValue[],
  selectedValues: string[] | undefined,
  facetKey: string,
  categoryValueIndex: Map<string, number> | null,
) => {
  const result = values.map((value, index) => {
    const entityId = resolveCategoryEntityId(value, categoryValueIndex, facetKey, index);
    const name = value.Label ?? value.Value ?? '';
    const originalValue = value.Value ?? value.Label ?? '';

    // Store mapping for later use when building selections
    entityIdToValueMap.set(`${facetKey}:${entityId}`, originalValue);

    hawksearchDebug('mapCategoryFacetValues - storing mapping', {
      facetKey,
      entityId,
      originalValue,
      mapKey: `${facetKey}:${entityId}`,
    });

    return {
      entityId,
      name,
      isSelected: value.Selected ?? (selectedValues?.includes(value.Value ?? '') ?? false),
      productCount: value.Count ?? 0,
      subCategories: {
        edges: value.Children
          ? value.Children.map((child, childIndex) => {
              const childEntityId = resolveCategoryEntityId(
                child,
                categoryValueIndex,
                facetKey,
                entityId * 1000 + childIndex,
              );
              const childOriginalValue = child.Value ?? child.Label ?? '';

              entityIdToValueMap.set(`${facetKey}:${childEntityId}`, childOriginalValue);

              return {
                node: {
                  entityId: childEntityId,
                  name: child.Label ?? child.Value ?? '',
                  isSelected: child.Selected ?? false,
                  productCount: child.Count ?? 0,
                },
              };
            })
          : [],
      },
    };
  });

  return result;
};

const mapBrandFacetValues = (
  values: HawksearchFacetValue[],
  selectedValues: string[] | undefined,
  facetKey: string,
) => {
  const result = values.map((value, index) => {
    const entityId = resolveBrandEntityId(value, facetKey, index);
    const name = value.Label ?? value.Value ?? '';
    const originalValue = value.Value ?? value.Label ?? '';

    // Store mapping for later use when building selections
    entityIdToValueMap.set(`${facetKey}:${entityId}`, originalValue);

    return {
      entityId,
      name,
      isSelected: value.Selected ?? (selectedValues?.includes(value.Value ?? '') ?? false),
      productCount: value.Count ?? 0,
    };
  });

  return result;
};

const mapAttributeFacetValues = (
  values: HawksearchFacetValue[],
  selectedValues: string[] | undefined,
) =>
  values.map((value) => ({
    value: value.Label ?? value.Value ?? '',
    isSelected: value.Selected ?? (selectedValues?.includes(value.Value ?? '') ?? false),
    productCount: value.Count ?? 0,
  }));

const mapFacet = (
  facet: HawksearchFacet,
  selections: Record<string, string[]>,
  filters: HawksearchFilters,
  categoryValueIndex: Map<string, number> | null,
) => {
  const displayName = normalizeFacetDisplayName(facet);
  const normalizedName = facet.Name.trim().toLowerCase();
  const normalizedKey = normalizeFilterKey(facet.Name);
  const values = toFacetValues(facet);
  const selectionValues =
    selections[facet.Name] ?? selections[normalizedKey] ?? selections[normalizedName];
  const facetKeys = getFacetKeys();

  if (normalizedName === 'category') {
    return {
      __typename: 'CategorySearchFilter',
      name: displayName,
      displayName,
      displayProductCount: true,
      isCollapsedByDefault: false,
      categories: mapCategoryFacetValues(
        values,
        selectionValues,
        facetKeys.category,
        categoryValueIndex,
      ),
    };
  }

  if (normalizedName === 'brand') {
    return {
      __typename: 'BrandSearchFilter',
      name: displayName,
      displayName,
      displayProductCount: true,
      isCollapsedByDefault: false,
      brands: mapBrandFacetValues(values, selectionValues, facetKeys.brand),
    };
  }

  if (normalizedName === 'price' || normalizedName === 'price_retail') {
    const selectedMin = filters.price?.minPrice ?? toNumber(values[0]?.RangeStart);
    const selectedMax = filters.price?.maxPrice ?? toNumber(values[0]?.RangeEnd);

    return {
      __typename: 'PriceSearchFilter',
      name: displayName,
      displayName,
      isCollapsedByDefault: false,
      selected:
        selectedMin != null || selectedMax != null
          ? {
              minPrice: selectedMin ?? null,
              maxPrice: selectedMax ?? null,
            }
          : null,
    };
  }

  if (normalizedName === 'rating') {
    return {
      __typename: 'RatingSearchFilter',
      name: displayName,
      displayName,
      isCollapsedByDefault: false,
      ratings: values.map((value) => ({
        value: value.Value ?? value.Label ?? '',
        isSelected: value.Selected ?? false,
        productCount: value.Count ?? 0,
      })),
    };
  }

  return {
    __typename: 'ProductAttributeSearchFilter',
    name: displayName,
    displayName,
    displayProductCount: true,
    filterName: facet.Name,
    isCollapsedByDefault: false,
    attributes: mapAttributeFacetValues(values, selectionValues),
  };
};

export const facetedHawkSearch = async ({
  limit = 9,
  after,
  before,
  sort,
  filters,
  currencyCode,
  categoryFilterValues,
}: FacetedHawksearchOptions) => {
  const pageNo = Number(after ?? before ?? 1);
  const keyword = typeof filters.searchTerm === 'string' ? filters.searchTerm.trim() : '';
  const categoryValueIndex = await getCategoryValueIndex();

  // First, make an initial query to populate the entityId mapping if needed
  // This is necessary when the map is empty (e.g., on first server-side render with user selections)
  if (
    (filters.categoryEntityIds && filters.categoryEntityIds.length > 0) ||
    filters.brandEntityIds && filters.brandEntityIds.length > 0
  ) {
    const facetKeys = getFacetKeys();
    const needsCategoryMapping =
      filters.categoryEntityIds &&
      filters.categoryEntityIds.some(
        (id) => !entityIdToValueMap.has(`${facetKeys.category}:${id}`),
      );
    const needsBrandMapping =
      filters.brandEntityIds &&
      filters.brandEntityIds.some((id) => !entityIdToValueMap.has(`${facetKeys.brand}:${id}`));

    if (needsCategoryMapping || needsBrandMapping) {
      hawksearchDebug('entityIdToValueMap needs population, making initial query', {
        needsCategoryMapping,
        needsBrandMapping,
        mapSize: entityIdToValueMap.size,
      });

      // Make initial query without user selections to get facets and populate map
      const initialSelections: Record<string, string[]> = {};

      if (categoryFilterValues && categoryFilterValues.length > 0) {
        initialSelections[facetKeys.category] = categoryFilterValues;
      }

      const { payload: initialPayload, fallbackPayload: initialFallback } =
        buildHawksearchPayloads({
          term: keyword,
          limit: 1, // We only need facets, not products
          pageNo: 1,
          sort: sort ?? undefined,
          facetSelections:
            Object.keys(initialSelections).length > 0 ? initialSelections : undefined,
        });

      const initialResponse = await runHawksearchSearch(initialPayload, initialFallback);

      // Process facets to populate the map
      initialResponse.Facets?.forEach((facet) => {
        const facetName = facet.Name.trim().toLowerCase();

        if (facetName === 'category') {
          mapCategoryFacetValues(
            facet.Values ?? [],
            undefined,
            facetKeys.category,
            categoryValueIndex,
          );
        } else if (facetName === 'brand') {
          mapBrandFacetValues(facet.Values ?? [], undefined, facetKeys.brand);
        }
      });

      hawksearchDebug('entityIdToValueMap populated', {
        mapSize: entityIdToValueMap.size,
        categoryEntries: Array.from(entityIdToValueMap.entries()).filter(([key]) =>
          key.startsWith(`${facetKeys.category}:`),
        ),
      });
    }
  }

  const selections = buildFacetSelections(filters, categoryFilterValues);

  hawksearchDebug('faceted search request', {
    limit,
    after,
    before,
    sort,
    filters,
    currencyCode,
    pageNo,
    keyword,
    selections,
    categoryFilterValues,
  });

  const { payload, fallbackPayload } = buildHawksearchPayloads({
    term: keyword,
    limit: limit ?? 9,
    pageNo: Number.isFinite(pageNo) && pageNo > 0 ? pageNo : 1,
    sort: sort ?? undefined,
    facetSelections: Object.keys(selections).length > 0 ? selections : undefined,
  });

  const response = await runHawksearchSearch(payload, fallbackPayload);

  const items = (response.Results ?? [])
    .map((result) => buildProductCard(result, currencyCode))
    .filter((product): product is ResultOf<typeof ProductCardFragment> => product != null);

  const pagination = response.Pagination;
  const currentPage = pagination?.CurrentPage ?? 1;
  const totalPages = pagination?.NofPages ?? 1;

  const facets =
    response.Facets?.map((facet) =>
      mapFacet(facet, selections, filters, categoryValueIndex),
    ) ?? [];

  hawksearchDebug('faceted search response', {
    itemCount: items.length,
    facetCount: facets.length,
    pagination,
    currentPage,
    totalPages,
  });

  return {
    facets: {
      items: facets,
    },
    products: {
      collectionInfo: {
        totalItems: pagination?.NofResults ?? items.length,
      },
      pageInfo: {
        hasNextPage: currentPage < totalPages,
        hasPreviousPage: currentPage > 1,
        startCursor: currentPage > 1 ? String(currentPage - 1) : null,
        endCursor: currentPage < totalPages ? String(currentPage + 1) : null,
      },
      items,
    },
  };
};

import type { ResultOf } from 'gql.tada';

import type { SearchProductFragment } from '~/components/header/_actions/fragment';
import type { ProductCardFragment } from '~/components/product-card/fragment';

export interface HawksearchConfig {
  server: string;
  clientGuid: string;
  indexName: string;
}

export interface HawksearchPagination {
  NofResults: number;
  CurrentPage: number;
  MaxPerPage: number;
  NofPages: number;
}

export interface HawksearchFacetValue {
  Value?: string;
  Label?: string;
  Count?: number;
  Selected?: boolean;
  RangeStart?: string;
  RangeEnd?: string;
  Children?: HawksearchFacetValue[];
}

export interface HawksearchFacet {
  Name: string;
  DisplayName?: string;
  Field?: string;
  ParamName?: string;
  Values?: HawksearchFacetValue[];
}

export interface HawksearchResult {
  DocId: string | number;
  IsVisible?: boolean;
  Document: Record<string, unknown>;
}

export interface HawksearchSearchResponse {
  Pagination?: HawksearchPagination;
  Results?: HawksearchResult[];
  Facets?: HawksearchFacet[];
}

export interface HawksearchSearchPayload {
  Keyword?: string;
  RequestType?: string;
  PageNo?: number;
  MaxPerPage?: number;
  SortBy?: string | null;
  FacetSelections?: Record<string, string[]>;
  query?: string;
}

const DEFAULT_CURRENCY = 'USD';
const DEFAULT_QUERY_FIELDS = ['name', 'product_name', 'sku'];
const DEFAULT_QUERY_MODE = 'prefix';
const DEFAULT_QUERY_MIN_CHARS = 2;
const DEFAULT_UNIFIED_MIN_WORDS = 3;

const trimValue = (value?: string) => value?.trim();

export const isHawksearchDebugEnabled = () => process.env.HAWKSEARCH_DEBUG === 'true';

export const hawksearchDebug = (message: string, data?: unknown) => {
  if (!isHawksearchDebugEnabled()) {
    return;
  }

  if (data === undefined) {
    // eslint-disable-next-line no-console
    console.log(`[hawksearch] ${message}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[hawksearch] ${message}`, data);
};

export const getHawksearchConfig = (): HawksearchConfig | null => {
  const server = trimValue(process.env.HAWKSEARCH_SERVER);
  const clientGuid = trimValue(process.env.HAWKSEARCH_CLIENT_GUID);
  const indexName = trimValue(process.env.HAWKSEARCH_INDEX);

  if (!server || !clientGuid || !indexName) {
    hawksearchDebug('config missing', {
      server: Boolean(server),
      clientGuid: Boolean(clientGuid),
      indexName: Boolean(indexName),
    });
    return null;
  }

  return {
    server,
    clientGuid,
    indexName,
  };
};

export const isHawksearchEnabled = () => getHawksearchConfig() !== null;

export const getHawksearchConfigOrThrow = (): HawksearchConfig => {
  const config = getHawksearchConfig();

  if (!config) {
    throw new Error(
      'HawkSearch is not configured. Set HAWKSEARCH_SERVER, HAWKSEARCH_CLIENT_GUID, and HAWKSEARCH_INDEX.',
    );
  }

  hawksearchDebug('config loaded', {
    server: config.server,
    indexName: config.indexName,
  });

  return config;
};

const buildEndpoint = (server: string) => `${server.replace(/\/+$/, '')}/api/v2/search`;

type QueryMode = 'keyword' | 'text' | 'prefix' | 'wildcard';

const parseQueryFields = (raw?: string | null): string[] => {
  if (!raw) {
    return DEFAULT_QUERY_FIELDS;
  }

  return raw
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '');
};

const getQueryMode = (): QueryMode => {
  const raw = process.env.HAWKSEARCH_QUERY_MODE?.toLowerCase();

  if (raw === 'keyword' || raw === 'text' || raw === 'prefix' || raw === 'wildcard') {
    return raw;
  }

  return DEFAULT_QUERY_MODE;
};

const getQueryMinChars = () => {
  const raw = process.env.HAWKSEARCH_QUERY_MIN_CHARS;
  const parsed = raw ? Number(raw) : NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUERY_MIN_CHARS;
};

const escapeQueryValue = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/ /g, '\\ ');

const withQueryMode = (field: string, mode: QueryMode) => {
  if (field.includes('.')) {
    return field;
  }

  return `${field}.${mode}`;
};

const buildFieldSpecificQuery = (term: string) => {
  const trimmed = term.trim();

  if (trimmed === '') {
    return undefined;
  }

  const minChars = getQueryMinChars();

  if (trimmed.length < minChars) {
    return undefined;
  }

  const fields = parseQueryFields(process.env.HAWKSEARCH_QUERY_FIELDS);
  const mode = getQueryMode();
  const escaped = escapeQueryValue(trimmed);

  if (fields.length === 0) {
    return undefined;
  }

  return fields.map((field) => `${withQueryMode(field, mode)}: ${escaped}`).join(' OR ');
};

const getRequestType = (term: string) => {
  const forced = process.env.HAWKSEARCH_REQUEST_TYPE;

  if (forced) {
    return forced;
  }

  if (process.env.HAWKSEARCH_ENABLE_UNIFIED !== 'true') {
    return undefined;
  }

  const minWordsRaw = process.env.HAWKSEARCH_UNIFIED_MIN_WORDS;
  const minWordsParsed = minWordsRaw ? Number(minWordsRaw) : NaN;
  const minWords =
    Number.isFinite(minWordsParsed) && minWordsParsed > 0 ? minWordsParsed : DEFAULT_UNIFIED_MIN_WORDS;
  const wordCount = term.trim().split(/\s+/).filter(Boolean).length;

  return wordCount >= minWords ? 'UnifiedSearch' : undefined;
};

export const buildHawksearchPayloads = ({
  term,
  limit,
  pageNo,
  sort,
  facetSelections,
}: {
  term: string;
  limit?: number;
  pageNo?: number;
  sort?: string | null;
  facetSelections?: Record<string, string[]>;
}) => {
  const keyword = term.trim();
  const query = buildFieldSpecificQuery(keyword);
  const requestType = keyword ? getRequestType(keyword) : undefined;

  return {
    payload: {
      Keyword: keyword !== '' ? keyword : undefined,
      RequestType: requestType,
      query,
      PageNo: pageNo,
      MaxPerPage: limit,
      SortBy: sort ?? undefined,
      FacetSelections: facetSelections,
    } satisfies HawksearchSearchPayload,
    fallbackPayload:
      keyword !== '' && query
        ? ({
            Keyword: undefined,
            RequestType: undefined,
            query,
            PageNo: pageNo,
            MaxPerPage: limit,
            SortBy: sort ?? undefined,
            FacetSelections: facetSelections,
          } satisfies HawksearchSearchPayload)
        : undefined,
  };
};

export const runHawksearchSearch = async (
  payload: HawksearchSearchPayload,
  fallbackPayload?: HawksearchSearchPayload,
) => {
  const response = await hawksearchRequest(payload);

  if ((response.Results?.length ?? 0) > 0 || !fallbackPayload) {
    return response;
  }

  hawksearchDebug('fallback search', { payload: fallbackPayload });

  return hawksearchRequest(fallbackPayload);
};

export const hawksearchRequest = async (
  payload: HawksearchSearchPayload,
): Promise<HawksearchSearchResponse> => {
  const { server, clientGuid, indexName } = getHawksearchConfigOrThrow();
  const endpoint = buildEndpoint(server);

  hawksearchDebug('request', {
    endpoint,
    payload,
    indexName,
    clientGuid: clientGuid ? '[set]' : '[missing]',
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      ClientGuid: clientGuid,
      IndexName: indexName,
      ...payload,
    }),
    cache: 'no-store',
  });

  hawksearchDebug('response status', { status: response.status, ok: response.ok });

  if (!response.ok) {
    throw new Error(`HawkSearch request failed with status ${response.status}.`);
  }

  const json = (await response.json()) as HawksearchSearchResponse;

  hawksearchDebug('response summary', {
    resultCount: json.Results?.length ?? 0,
    facetCount: json.Facets?.length ?? 0,
    pagination: json.Pagination,
  });

  if (isHawksearchDebugEnabled() && json.Facets) {
    const facetPreview = json.Facets.map((facet) => ({
      name: facet.Name,
      displayName: facet.DisplayName,
      field: facet.Field,
      paramName: facet.ParamName,
      values: (facet.Values ?? []).slice(0, 5).map((value) => ({
        value: value.Value,
        label: value.Label,
        count: value.Count,
        selected: value.Selected,
      })),
    }));

    hawksearchDebug('response facets preview', facetPreview);
  }

  return json;
};

const normalizeArray = (value: unknown): Array<string | number> => {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter((item) => item != null) as Array<string | number>;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return [value];
  }

  return [];
};

const firstValue = (value: unknown) => normalizeArray(value)[0];

const firstString = (value: unknown): string | undefined => {
  const candidate = firstValue(value);

  if (typeof candidate === 'string') {
    return candidate;
  }

  if (typeof candidate === 'number') {
    return candidate.toString();
  }

  return undefined;
};

const firstNumber = (value: unknown): number | undefined => {
  const candidate = firstValue(value);

  if (typeof candidate === 'number') {
    return candidate;
  }

  if (typeof candidate === 'string' && candidate.trim() !== '') {
    const parsed = Number(candidate);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
};

const getFirstFieldValue = (document: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    if (document[key] != null) {
      return document[key];
    }
  }

  return undefined;
};

const getStringArray = (document: Record<string, unknown>, keys: string[]) =>
  normalizeArray(getFirstFieldValue(document, keys))
    .map((value) => (typeof value === 'string' ? value : value?.toString?.()))
    .filter((value): value is string => Boolean(value && value.trim() !== ''));

const FIELD_KEYS = {
  id: ['unique_id', 'product_id', 'entity_id', 'id'],
  name: ['name', 'title', 'product_name'],
  image: ['image', 'image_url', 'imageurl', 'image_urls'],
  url: ['url_detail', 'url', 'link'],
  price: ['price_retail', 'price', 'sale_price'],
  inventory: ['metric_inventory', 'inventory', 'stock'],
  brand: ['brand', 'manufacturer', 'brand_name'],
  brandPath: ['brand_path', 'brand_url', 'brand_link'],
  category: ['category', 'categories'],
  categoryPath: ['category_path', 'category_url', 'category_link'],
  rating: ['rating', 'average_rating'],
};

const buildCategoryEdges = (document: Record<string, unknown>) => {
  const rawCategories = getStringArray(document, FIELD_KEYS.category);
  const rawCategoryPaths = getStringArray(document, FIELD_KEYS.categoryPath);

  return rawCategories.map((category, index) => {
    const parts = category.split('|').map((value) => value.trim()).filter(Boolean);
    const name = parts.at(-1) ?? category;
    const path = rawCategoryPaths[index] ?? '#';

    return {
      node: {
        name,
        path,
      },
    };
  });
};

const resolveCurrencyCode = (currencyCode?: string) => currencyCode ?? DEFAULT_CURRENCY;

const resolveEntityId = (result: HawksearchResult) => {
  const documentId = getFirstFieldValue(result.Document, FIELD_KEYS.id);
  const parsedId = firstNumber(documentId) ?? firstNumber(result.DocId);

  if (!Number.isFinite(parsedId)) {
    return null;
  }

  return parsedId ?? null;
};

export const buildProductCard = (
  result: HawksearchResult,
  currencyCode?: string,
): ResultOf<typeof ProductCardFragment> | null => {
  const entityId = resolveEntityId(result);

  if (!entityId) {
    return null;
  }

  const name = firstString(getFirstFieldValue(result.Document, FIELD_KEYS.name)) ?? '';
  const imageUrl = firstString(getFirstFieldValue(result.Document, FIELD_KEYS.image));
  const path = firstString(getFirstFieldValue(result.Document, FIELD_KEYS.url)) ?? '#';
  const brandName = firstString(getFirstFieldValue(result.Document, FIELD_KEYS.brand));
  const brandPath = firstString(getFirstFieldValue(result.Document, FIELD_KEYS.brandPath)) ?? '#';
  const rating = firstNumber(getFirstFieldValue(result.Document, FIELD_KEYS.rating)) ?? 0;
  const priceValue = firstNumber(getFirstFieldValue(result.Document, FIELD_KEYS.price)) ?? 0;
  const inventoryValue = firstNumber(getFirstFieldValue(result.Document, FIELD_KEYS.inventory)) ?? 0;
  const currency = resolveCurrencyCode(currencyCode);

  return {
    entityId,
    name,
    defaultImage: imageUrl
      ? {
          altText: name,
          url: imageUrl,
        }
      : null,
    path,
    brand: brandName
      ? {
          name: brandName,
          path: brandPath,
        }
      : null,
    inventory: {
      hasVariantInventory: false,
      isInStock: inventoryValue > 0,
      aggregated: {
        availableForBackorder: 0,
        unlimitedBackorder: false,
        availableOnHand: inventoryValue > 0 ? 1 : 0,
      },
    },
    reviewSummary: {
      numberOfReviews: 0,
      averageRating: rating,
    },
    variants: {
      edges: [],
    },
    prices: {
      price: {
        value: priceValue,
        currencyCode: currency,
      },
      basePrice: {
        value: priceValue,
        currencyCode: currency,
      },
      retailPrice: null,
      salePrice: null,
      priceRange: {
        min: {
          value: priceValue,
          currencyCode: currency,
        },
        max: {
          value: priceValue,
          currencyCode: currency,
        },
      },
    },
  };
};

export const buildSearchProduct = (
  result: HawksearchResult,
  currencyCode?: string,
): ResultOf<typeof SearchProductFragment> | null => {
  const baseProduct = buildProductCard(result, currencyCode);

  if (!baseProduct) {
    return null;
  }

  const categoryEdges = buildCategoryEdges(result.Document);
  const hasCategoryLinks = categoryEdges.some(
    (edge) => edge.node.path && edge.node.path !== '#',
  );
  const brand =
    baseProduct.brand && baseProduct.brand.path !== '#' ? baseProduct.brand : null;

  return {
    ...baseProduct,
    brand,
    categories: {
      edges: hasCategoryLinks ? categoryEdges : [],
    },
  };
};

export const hawkSearch = async (
  term: string,
  {
    limit = 5,
    currencyCode,
  }: {
    limit?: number;
    currencyCode?: string;
  } = {},
): Promise<ResultOf<typeof SearchProductFragment>[]> => {
  hawksearchDebug('quick search', { term, limit, currencyCode });

  const { payload, fallbackPayload } = buildHawksearchPayloads({
    term,
    limit,
  });

  const response = await runHawksearchSearch(payload, fallbackPayload);

  const results = response.Results ?? [];
  hawksearchDebug('quick search results', { total: results.length });

  return results
    .map((result) => buildSearchProduct(result, currencyCode))
    .filter((product): product is ResultOf<typeof SearchProductFragment> => product != null);
};

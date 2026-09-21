# HawkSearch Quick Start for BigCommerce Catalyst

This guide shows the shortest practical path for adding HawkSearch to a BigCommerce Catalyst storefront.

The reference POC already contains the HawkSearch adapters and Catalyst wiring. New developers should reuse those files instead of rebuilding the integration from scratch.

---

## What you are adding

HawkSearch will power three Catalyst experiences:

1. Header search autocomplete
2. The full search results page
3. Category product listings and filters

The browser does not call HawkSearch directly. Catalyst calls HawkSearch from the Next.js server and converts the response into the existing Catalyst product and filter formats.

```text
Customer search
  -> Catalyst server
  -> HawkSearch API
  -> HawkSearch adapter
  -> existing Catalyst cards and filters
```

No HawkSearch SDK is required. The adapter uses the standard `fetch` API.

---

## POC files to provide to developers

Provide this guide together with the following two adapter files from the reference POC:

```text
core/client/hawksearch.ts
core/client/faceted-hawksearch.ts
```

These are the only new HawkSearch-specific files.

The following existing Catalyst files contain the integration points. Developers should merge the relevant POC changes into their Catalyst version instead of blindly replacing the whole files:

```text
core/app/[locale]/(default)/(faceted)/fetch-faceted-search.ts
core/components/header/_actions/search.ts
core/app/[locale]/(default)/(faceted)/search/page.tsx
core/app/[locale]/(default)/(faceted)/category/[slug]/page.tsx
core/data-transformers/facets-transformer.ts
core/vibes/soul/sections/products-list-section/filters-panel.tsx
```

### File responsibilities

| File | What it does |
| --- | --- |
| `hawksearch.ts` | Reads configuration, calls the API, and converts HawkSearch documents into Catalyst products |
| `faceted-hawksearch.ts` | Converts Catalyst filters into HawkSearch facet selections and maps facets back to Catalyst |
| `fetch-faceted-search.ts` | Chooses HawkSearch or the existing BigCommerce search provider |
| Header `search.ts` | Uses HawkSearch for autocomplete |
| Search `page.tsx` | Supplies HawkSearch products, counts, filters, and pagination to the existing results UI |
| Category `page.tsx` | Uses the same search path for category listings |
| `facets-transformer.ts` | Converts returned facets into frontend filter controls |
| `filters-panel.tsx` | Renders checkbox/range filters and writes selections to the URL |

> [!IMPORTANT]
> Copy the two new adapter files. Merge the other six files carefully because Catalyst versions may differ.

---

## Before you start

You need:

- A working Catalyst storefront
- A HawkSearch server URL
- A HawkSearch client GUID
- A HawkSearch index name
- Access to inspect the product fields and facets in that index

First confirm that Catalyst already runs correctly with BigCommerce. HawkSearch should be added only after the existing storefront works.

---

## Quick setup

### Step 1: Copy the two adapters

Copy these files from the reference POC into the same locations in the target Catalyst project:

```text
core/client/hawksearch.ts
core/client/faceted-hawksearch.ts
```

No additional npm package is required.

### Step 2: Add environment values

Add these values to the local `.env.local` file and to the deployment environment:

```dotenv
HAWKSEARCH_SERVER=https://your-hawksearch-host
HAWKSEARCH_CLIENT_GUID=your-client-guid
HAWKSEARCH_INDEX=your-index-name
```

All three values are required. If any value is missing, the provider switch keeps using the existing BigCommerce search.

For local debugging, also add:

```dotenv
HAWKSEARCH_DEBUG=true
```

Never commit real values or expose them through `NEXT_PUBLIC_` variables.

### Step 3: Confirm the product field mapping

Open `core/client/hawksearch.ts` and find `FIELD_KEYS`.

The reference adapter understands these common HawkSearch fields:

| Product data | Supported fields |
| --- | --- |
| ID | `unique_id`, `product_id`, `entity_id`, `id`, or `DocId` |
| Name | `name`, `title`, `product_name` |
| Image | `image`, `image_url`, `imageurl`, `image_urls` |
| URL | `url_detail`, `url`, `link` |
| Price | `price_retail`, `price`, `sale_price` |
| Inventory | `metric_inventory`, `inventory`, `stock` |
| Brand | `brand`, `manufacturer`, `brand_name` |
| Category | `category`, `categories` |
| Rating | `rating`, `average_rating` |

If the target HawkSearch index uses different field names, update `FIELD_KEYS` before testing.

The product ID must resolve to the numeric BigCommerce product entity ID. Otherwise Catalyst cannot build a valid product card or product link.

### Step 4: Confirm the facet keys

The default facet keys are:

```text
Category: category
Brand:    brand
Price:    price_retail
Rating:   rating
```

If the index uses different keys, add a JSON override:

```dotenv
HAWKSEARCH_FACET_KEYS={"category":"category_path","brand":"manufacturer","price":"price_sale","rating":"rating"}
```

The values must match the HawkSearch index exactly.

### Step 5: Merge the full-search provider switch

In:

```text
core/app/[locale]/(default)/(faceted)/fetch-faceted-search.ts
```

Import the HawkSearch functions:

```ts
import { facetedHawkSearch } from '~/client/faceted-hawksearch';
import { isHawksearchEnabled } from '~/client/hawksearch';
```

Add the HawkSearch branch before the existing BigCommerce GraphQL request:

```ts
if (isHawksearchEnabled()) {
  return facetedHawkSearch({
    limit,
    after,
    before,
    sort: sort ?? undefined,
    filters,
    currencyCode,
    categoryFilterValues,
  });
}

// Keep the existing BigCommerce search below this branch.
```

Use the complete POC version of `fetch-faceted-search.ts` as the reference for:

- URL parameter validation
- `term`, `query`, and `q` support
- Category lookup values
- Brand, category, price, rating, and attribute filters

### Step 6: Merge header autocomplete

In:

```text
core/components/header/_actions/search.ts
```

Import:

```ts
import { hawkSearch, isHawksearchEnabled } from '~/client/hawksearch';
```

Use HawkSearch when configured:

```ts
const products = isHawksearchEnabled()
  ? await hawkSearch(submission.value.term, {
      limit: 5,
      currencyCode,
    })
  : await existingBigCommerceQuickSearch();
```

The example above is simplified. Keep the existing BigCommerce GraphQL branch from the target Catalyst project.

The reference implementation waits for at least three characters before calling either search provider.

### Step 7: Merge search, category, and filter UI changes

Use the POC versions of these files as a comparison:

```text
core/app/[locale]/(default)/(faceted)/search/page.tsx
core/app/[locale]/(default)/(faceted)/category/[slug]/page.tsx
core/data-transformers/facets-transformer.ts
core/vibes/soul/sections/products-list-section/filters-panel.tsx
```

The important behavior to preserve is:

- Search and category pages call the shared `fetchFacetedSearch()` function.
- Returned products continue through `productCardTransformer()`.
- Returned facets continue through `facetsTransformer()`.
- Existing `ProductsListSection` renders cards, filters, sorting, and pagination.
- Filter selections are stored in the URL.
- Changing a filter clears the current pagination state.

You do not need to create a separate HawkSearch React component.

### Step 8: Install and run

Use the commands defined by the target Catalyst project. For this Catalyst structure:

```bash
corepack enable
pnpm install
pnpm dev
```

Restart the server whenever environment values change.

With debugging enabled, the server terminal should show log entries beginning with:

```text
[hawksearch]
```

---

## How the API request works

The adapter sends a server-side `POST` request to:

```text
{HAWKSEARCH_SERVER}/api/v2/search
```

A simple request looks like this:

```json
{
  "ClientGuid": "your-client-guid",
  "IndexName": "your-index-name",
  "Keyword": "shirt",
  "PageNo": 1,
  "MaxPerPage": 9
}
```

A filtered request can also contain:

```json
{
  "SortBy": "LOWEST_PRICE",
  "FacetSelections": {
    "brand": ["Acme"],
    "category": ["Men|Shirts"],
    "color": ["Blue"],
    "price_retail": ["25,100"]
  }
}
```

The response provides:

| Response field | Used for |
| --- | --- |
| `Results` | Product cards and autocomplete products |
| `Facets` | Category, brand, price, rating, and attribute filters |
| `Pagination` | Result count, current page, and next/previous state |

The adapter converts these values into the format already expected by Catalyst.

---

## Request flow

### Header autocomplete

```text
Customer types 3+ characters
  -> header server action
  -> hawkSearch(term, limit: 5)
  -> HawkSearch API
  -> buildSearchProduct()
  -> existing Catalyst autocomplete UI
```

### Full search or category page

```text
URL search parameters
  -> fetchFacetedSearch()
  -> facetedHawkSearch()
  -> HawkSearch API
  -> products + facets + pagination
  -> existing Catalyst transformers
  -> existing ProductsListSection
```

### Filter selection

```text
Customer selects a filter
  -> filter is written to the URL
  -> Next.js performs a server navigation
  -> Catalyst builds HawkSearch FacetSelections
  -> new results and facets are rendered
```

---

## Quick verification

Test these items in order:

1. Open the storefront and confirm normal pages still load.
2. Type two characters in header search; no provider search should run.
3. Type a third character; autocomplete should show HawkSearch products.
4. Submit the term and confirm the full results page loads.
5. Open one returned product and confirm the URL is correct.
6. Select a category filter.
7. Select a brand or product attribute.
8. Apply a price range.
9. Change the sort order.
10. Move to the next results page.
11. Refresh and use browser back/forward to confirm URL state is preserved.
12. Check the server terminal for HawkSearch errors.

Also verify product ID, name, image, price, currency, inventory, category, and brand against the source data. A card rendering successfully does not guarantee its commerce data is correct.

Run the repository checks before release:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

---

## Common problems

| Problem | Check |
| --- | --- |
| BigCommerce results still appear | All three required environment values must be set; restart the server |
| HawkSearch returns 404 | `HAWKSEARCH_SERVER` should be a base URL; the adapter adds `/api/v2/search` |
| API returns products but the UI is empty | Check that `DocId` or an ID field contains the numeric BigCommerce entity ID |
| Product URL is `#` | Check the indexed URL field and `FIELD_KEYS.url` |
| Price is zero | Check the indexed price field and `FIELD_KEYS.price` |
| All products look out of stock | Confirm whether the indexed inventory value is a numeric quantity |
| A filter renders but does nothing | Check the facet `Name`, `Field`, `ParamName`, and outgoing selection key |
| Category selection changes incorrectly | Check the category value-to-entity-ID mapping |
| Sorting does not change results | Confirm the outgoing `SortBy` value exists in HawkSearch |
| Works locally but not after deployment | Check deployment environment values and server access to HawkSearch |

For debugging, follow the data in this order:

```text
Raw HawkSearch response
  -> adapter output
  -> Catalyst transformer output
  -> rendered UI
  -> URL after interaction
```

Fix the first place where the actual value differs from the expected value.

---

## Important production notes

Before production release, review these behaviors:

- HawkSearch requests currently use `cache: 'no-store'`.
- A HawkSearch HTTP error does not automatically fall back to BigCommerce.
- The adapter can make an additional HawkSearch request to resolve selected facet metadata.
- The search page can make another request for the unfiltered facet baseline.
- HawkSearch page numbers are adapted to Catalyst's cursor-style pagination props.
- Category and brand reverse mapping currently uses module-level state and should be reviewed for request isolation.
- Real credentials and complete result documents should not be logged.
- Add focused tests for payload creation, product mapping, facet mapping, pagination, and HTTP errors.

---

## Handoff checklist

Provide developers with:

- [ ] This quick-start guide
- [ ] `core/client/hawksearch.ts`
- [ ] `core/client/faceted-hawksearch.ts`
- [ ] The six POC integration files for comparison
- [ ] HawkSearch server URL through the approved secret-sharing process
- [ ] HawkSearch client GUID through the approved secret-sharing process
- [ ] HawkSearch index name
- [ ] A list of product field names
- [ ] A list of facet keys and expected values
- [ ] A list of supported sort values

The simplest way to remember the integration is:

```text
Copy 2 adapters
  -> merge 6 Catalyst integration points
  -> add 3 environment values
  -> verify fields and facets
  -> test search end to end
```

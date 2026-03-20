/* eslint-disable complexity */
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { z } from 'zod';

import {
  fetchFacetedSearch,
  PublicSearchParamsSchema,
  PublicToPrivateParams,
} from '~/app/[locale]/(default)/(faceted)/fetch-faceted-search';
import { client } from '~/client';
import { graphql } from '~/client/graphql';
import { revalidate } from '~/client/revalidate-target';
import { ExistingResultType } from '~/client/util';

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
type CategoryTreeNode = {
  entityId: number;
  name: string;
  path: string;
  productCount: number;
  children?: CategoryTreeNode[] | null;
};

const buildCategoryTreeIndex = (items: CategoryTreeNode[]) => {
  const index = new Map<number, CategoryTreeNode>();

  const walk = (node: CategoryTreeNode) => {
    index.set(node.entityId, node);

    node.children?.forEach(walk);
  };

  items.forEach(walk);

  return index;
};

const buildCategoryTreeParentIndex = (items: CategoryTreeNode[]) => {
  const index = new Map<number, number>();

  const walk = (node: CategoryTreeNode, parentId?: number) => {
    if (parentId != null) {
      index.set(node.entityId, parentId);
    }

    node.children?.forEach((child) => walk(child, node.entityId));
  };

  items.forEach((item) => walk(item));

  return index;
};

const normalizeCategoryLabel = (value: string) => {
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

const buildCategoryTreeNameIndex = (items: CategoryTreeNode[]) => {
  const index = new Map<string, CategoryTreeNode>();

  const walk = (node: CategoryTreeNode, ancestors: string[]) => {
    const path = node.path?.replace(/\/+$/, '') ?? '';
    const slug = path.split('/').filter(Boolean).at(-1) ?? '';
    const breadcrumb = [...ancestors, node.name].join('|');
    const keys = [node.name, path, slug, breadcrumb]
      .map(normalizeCategoryLabel)
      .filter(Boolean);

    keys.forEach((key) => {
      if (!index.has(key)) {
        index.set(key, node);
      }
    });

    node.children?.forEach((child) => walk(child, [...ancestors, node.name]));
  };

  items.forEach((item) => walk(item, []));

  return index;
};

const hasSelectedDescendant = (
  node: CategoryTreeNode,
  selectedCategoryIds: Set<number>,
): boolean => {
  if (!node.children || node.children.length === 0) {
    return false;
  }

  for (const child of node.children) {
    if (selectedCategoryIds.has(child.entityId)) {
      return true;
    }

    if (hasSelectedDescendant(child, selectedCategoryIds)) {
      return true;
    }
  }

  return false;
};

export const facetsTransformer = async ({
  refinedFacets,
  allFacets,
  searchParams,
}: {
  refinedFacets: ExistingResultType<typeof fetchFacetedSearch>['facets']['items'][number][];
  allFacets: ExistingResultType<typeof fetchFacetedSearch>['facets']['items'][number][];
  searchParams: z.input<typeof PublicSearchParamsSchema>;
}) => {
  const t = await getTranslations('Faceted.FacetedSearch.Facets');
  const { filters } = PublicToPrivateParams.parse(searchParams);
  const selectedCategoryIds = new Set(filters.categoryEntityIds ?? []);
  let categoryTree: CategoryTreeNode[] | null = null;
  let categoryTreeIndex: Map<number, CategoryTreeNode> | null = null;
  let categoryTreeParentIndex: Map<number, number> | null = null;
  let categoryTreeNameIndex: Map<string, CategoryTreeNode> | null = null;
  let refinedCategoryLookup:
    | Map<number, { productCount: number; subCategoryCounts: Map<number, number> }>
    | null = null;

  if (selectedCategoryIds.size > 0) {
    const categoryFacet = allFacets.find(
      (facet) => facet.__typename === 'CategorySearchFilter',
    );
    const needsTree = categoryFacet?.__typename === 'CategorySearchFilter';

    if (needsTree) {
      const loadedCategoryTree = await getCategoryTree();

      categoryTree = loadedCategoryTree;
      categoryTreeIndex = buildCategoryTreeIndex(loadedCategoryTree);
      categoryTreeParentIndex = buildCategoryTreeParentIndex(loadedCategoryTree);
      categoryTreeNameIndex = buildCategoryTreeNameIndex(loadedCategoryTree);
    }
  }

  return allFacets.map((facet) => {
    const refinedFacet = refinedFacets.find((f) => f.displayName === facet.displayName);

    if (facet.__typename === 'CategorySearchFilter') {
      const refinedCategorySearchFilter =
        refinedFacet?.__typename === 'CategorySearchFilter' ? refinedFacet : null;
      if (refinedCategorySearchFilter && refinedCategoryLookup == null) {
        refinedCategoryLookup = new Map();

        refinedCategorySearchFilter.categories?.forEach((category) => {
          const subCategoryCounts = new Map<number, number>();

          category.subCategories?.edges?.forEach((edge) => {
            subCategoryCounts.set(edge.node.entityId, edge.node.productCount);
          });

          refinedCategoryLookup?.set(category.entityId, {
            productCount: category.productCount,
            subCategoryCounts,
          });
        });
      }

      if (categoryTree) {
        const options = categoryTree.flatMap((category) => {
          const refinedCategory = refinedCategoryLookup?.get(category.entityId);
          const isSelected = selectedCategoryIds.has(category.entityId);
          const disabled = refinedCategory == null && !isSelected;
          const productCountLabel = disabled
            ? ''
            : ` (${refinedCategory?.productCount ?? category.productCount})`;
          const label = facet.displayProductCount
            ? `${category.name}${productCountLabel}`
            : category.name;

          const parentOption = {
            label,
            value: category.entityId.toString(),
            disabled,
          };

          const children = category.children ?? [];
          const childIds = children.map((child) => child.entityId);
          const childSelected = childIds.some((id) => selectedCategoryIds.has(id));
          const descendantSelected = hasSelectedDescendant(category, selectedCategoryIds);
          const shouldShowSubCategories =
            isSelected || childSelected || descendantSelected || refinedCategory != null;
          const subCategoryOptions = shouldShowSubCategories
            ? children.map((subCategory) => {
                const isSubSelected = selectedCategoryIds.has(subCategory.entityId);
                const refinedCounts = refinedCategoryLookup?.get(category.entityId);
                const hasRefinedChildData =
                  refinedCounts?.subCategoryCounts != null &&
                  refinedCounts.subCategoryCounts.size > 0;
                const refinedSubCount = hasRefinedChildData
                  ? refinedCounts?.subCategoryCounts?.get(subCategory.entityId)
                  : null;
                const subDisabled = hasRefinedChildData
                  ? refinedSubCount == null && !isSubSelected
                  : false;
                const countSource = refinedSubCount ?? subCategory.productCount;
                const subProductCountLabel =
                  facet.displayProductCount && !subDisabled && countSource != null
                    ? ` (${countSource})`
                    : '';
                const subLabel = facet.displayProductCount
                  ? `  ${subCategory.name}${subProductCountLabel}`
                  : `  ${subCategory.name}`;

                return {
                  label: subLabel,
                  value: subCategory.entityId.toString(),
                  disabled: subDisabled,
                };
              })
            : [];

          return [parentOption, ...subCategoryOptions];
        });

        return {
          type: 'toggle-group' as const,
          paramName: 'categoryIn',
          label: facet.displayName,
          defaultCollapsed: facet.isCollapsedByDefault,
          options,
        };
      }

      // Flatten categories and subcategories into a single options array
      const options = (facet.categories ?? []).flatMap((category) => {
        const refinedCategory = refinedCategorySearchFilter?.categories?.find(
          (c) => c.entityId === category.entityId,
        );
        const isSelected = filters.categoryEntityIds?.includes(category.entityId) === true;
        const disabled = refinedCategory == null && !isSelected;
        // Use refined count if available, otherwise use original count
        const productCountLabel = disabled
          ? ''
          : ` (${refinedCategory?.productCount ?? category.productCount})`;
        const label = facet.displayProductCount
          ? `${category.name}${productCountLabel}`
          : category.name;

        const parentOption = {
          label,
          value: category.entityId.toString(),
          disabled,
        };

        // Add subcategories with indentation - show them if parent is selected or if they have refined data
        const treeNodeById = categoryTreeIndex?.get(category.entityId);
        let treeNode =
          treeNodeById ??
          categoryTreeNameIndex?.get(normalizeCategoryLabel(category.name));

        if (!treeNodeById && treeNode && !treeNode.children?.length) {
          const parentId = categoryTreeParentIndex?.get(treeNode.entityId);
          const parentNode = parentId ? categoryTreeIndex?.get(parentId) : undefined;

          if (parentNode) {
            treeNode = parentNode;
          }
        }

        const fallbackChildren = treeNode?.children ?? [];
        const facetChildren = category.subCategories?.edges ?? [];
        const useTreeFallback = fallbackChildren.length > 0;
        const childIds = useTreeFallback
          ? fallbackChildren.map((child) => child.entityId)
          : facetChildren.map((edge) => edge.node.entityId);
        const childSelected = childIds.some((id) => selectedCategoryIds.has(id));
        const descendantSelected =
          treeNode != null
            ? hasSelectedDescendant(treeNode, selectedCategoryIds)
            : childSelected;
        const shouldShowSubCategories =
          isSelected || childSelected || descendantSelected || refinedCategory != null;
        const subCategoryOptions = shouldShowSubCategories
          ? useTreeFallback
            ? fallbackChildren.map((subCategory) => {
                const isSubSelected =
                  filters.categoryEntityIds?.includes(subCategory.entityId) === true;
                const refinedCounts = refinedCategoryLookup?.get(category.entityId);
                const hasRefinedChildData =
                  refinedCounts?.subCategoryCounts != null &&
                  refinedCounts.subCategoryCounts.size > 0;
                const refinedSubCount = hasRefinedChildData
                  ? refinedCounts?.subCategoryCounts?.get(subCategory.entityId)
                  : null;
                const subDisabled = hasRefinedChildData
                  ? refinedSubCount == null && !isSubSelected
                  : false;
                const countSource = refinedSubCount ?? subCategory.productCount;
                const subProductCountLabel =
                  facet.displayProductCount && !subDisabled && countSource != null
                    ? ` (${countSource})`
                    : '';
                const subLabel = facet.displayProductCount
                  ? `  ${subCategory.name}${subProductCountLabel}`
                  : `  ${subCategory.name}`;

                return {
                  label: subLabel,
                  value: subCategory.entityId.toString(),
                  disabled: subDisabled,
                };
              })
            : facetChildren.map((edge) => {
                const subCategory = edge.node;
                const refinedSubCategory = refinedCategory?.subCategories?.edges?.find(
                  (e) => e.node.entityId === subCategory.entityId,
                )?.node;
                const isSubSelected =
                  filters.categoryEntityIds?.includes(subCategory.entityId) === true;
                const subDisabled = refinedSubCategory == null && !isSubSelected;
                const subProductCountLabel = subDisabled
                  ? ''
                  : ` (${refinedSubCategory?.productCount ?? subCategory.productCount})`;
                const subLabel = facet.displayProductCount
                  ? `  ${subCategory.name}${subProductCountLabel}`
                  : `  ${subCategory.name}`;

                return {
                  label: subLabel,
                  value: subCategory.entityId.toString(),
                  disabled: subDisabled,
                };
              })
          : [];

        return [parentOption, ...subCategoryOptions];
      });

      return {
        type: 'toggle-group' as const,
        paramName: 'categoryIn',
        label: facet.displayName,
        defaultCollapsed: facet.isCollapsedByDefault,
        options,
      };
    }

    if (facet.__typename === 'BrandSearchFilter') {
      const refinedBrandSearchFilter =
        refinedFacet?.__typename === 'BrandSearchFilter' ? refinedFacet : null;

      return {
        type: 'toggle-group' as const,
        paramName: 'brand',
        label: facet.displayName,
        defaultCollapsed: facet.isCollapsedByDefault,
        options: (facet.brands ?? []).map((brand) => {
          const refinedBrand = refinedBrandSearchFilter?.brands?.find(
            (b) => b.entityId === brand.entityId,
          );
          const isSelected = filters.brandEntityIds?.includes(brand.entityId) === true;
          const disabled = refinedBrand == null && !isSelected;
          const productCountLabel = disabled ? '' : ` (${brand.productCount})`;
          const label = facet.displayProductCount
            ? `${brand.name}${productCountLabel}`
            : brand.name;

          return {
            label,
            value: brand.entityId.toString(),
            disabled,
          };
        }),
      };
    }

    if (facet.__typename === 'ProductAttributeSearchFilter') {
      const refinedProductAttributeSearchFilter =
        refinedFacet?.__typename === 'ProductAttributeSearchFilter' ? refinedFacet : null;

      return {
        type: 'toggle-group' as const,
        paramName: `attr_${facet.filterKey}`,
        label: facet.displayName,
        defaultCollapsed: facet.isCollapsedByDefault,
        options: (facet.attributes ?? []).map((attribute) => {
          const refinedAttribute = refinedProductAttributeSearchFilter?.attributes?.find(
            (a) => a.value === attribute.value,
          );

          const isSelected =
            filters.productAttributes?.some((attr) => attr.values.includes(attribute.value)) ===
            true;

          const disabled = refinedAttribute == null && !isSelected;
          const productCountLabel = disabled ? '' : ` (${attribute.productCount})`;
          const label = facet.displayProductCount
            ? `${attribute.value}${productCountLabel}`
            : attribute.value;

          return {
            label,
            value: attribute.value,
            disabled,
          };
        }),
      };
    }

    if (facet.__typename === 'RatingSearchFilter') {
      const refinedRatingSearchFilter =
        refinedFacet?.__typename === 'RatingSearchFilter' ? refinedFacet : null;
      const isSelected = filters.rating?.minRating != null;

      return {
        type: 'rating' as const,
        paramName: 'minRating',
        label: facet.displayName,
        disabled: refinedRatingSearchFilter == null && !isSelected,
        defaultCollapsed: facet.isCollapsedByDefault,
      };
    }

    if (facet.__typename === 'PriceSearchFilter') {
      const refinedPriceSearchFilter =
        refinedFacet?.__typename === 'PriceSearchFilter' ? refinedFacet : null;
      const isSelected = filters.price?.minPrice != null || filters.price?.maxPrice != null;

      return {
        type: 'range' as const,
        minParamName: 'minPrice',
        maxParamName: 'maxPrice',
        label: facet.displayName,
        min: facet.selected?.minPrice ?? undefined,
        max: facet.selected?.maxPrice ?? undefined,
        disabled: refinedPriceSearchFilter == null && !isSelected,
        defaultCollapsed: facet.isCollapsedByDefault,
      };
    }

    if ('freeShipping' in facet && facet.freeShipping) {
      const refinedFreeShippingSearchFilter =
        refinedFacet && 'freeShipping' in refinedFacet && refinedFacet.freeShipping
          ? refinedFacet
          : null;
      const isSelected = filters.isFreeShipping === true;

      return {
        type: 'toggle-group' as const,
        paramName: `shipping`,
        label: t('freeShippingLabel'),
        defaultCollapsed: facet.isCollapsedByDefault,
        options: [
          {
            label: t('freeShippingLabel'),
            value: 'free_shipping',
            disabled: refinedFreeShippingSearchFilter == null && !isSelected,
          },
        ],
      };
    }

    if ('isFeatured' in facet && facet.isFeatured) {
      const refinedIsFeaturedSearchFilter =
        refinedFacet && 'isFeatured' in refinedFacet && refinedFacet.isFeatured
          ? refinedFacet
          : null;
      const isSelected = filters.isFeatured === true;

      return {
        type: 'toggle-group' as const,
        paramName: `isFeatured`,
        label: t('isFeaturedLabel'),
        defaultCollapsed: facet.isCollapsedByDefault,
        options: [
          {
            label: t('isFeaturedLabel'),
            value: 'on',
            disabled: refinedIsFeaturedSearchFilter == null && !isSelected,
          },
        ],
      };
    }

    if ('isInStock' in facet && facet.isInStock) {
      const refinedIsInStockSearchFilter =
        refinedFacet && 'isInStock' in refinedFacet && refinedFacet.isInStock
          ? refinedFacet
          : null;
      const isSelected = filters.hideOutOfStock === true;

      return {
        type: 'toggle-group' as const,
        paramName: `stock`,
        label: t('inStockLabel'),
        defaultCollapsed: facet.isCollapsedByDefault,
        options: [
          {
            label: t('inStockLabel'),
            value: 'in_stock',
            disabled: refinedIsInStockSearchFilter == null && !isSelected,
          },
        ],
      };
    }

    return null;
  });
};

import { expect, Page, test } from '~/tests/fixtures';

const SHOP_ALL_URL = '/shop-all/';

const PRODUCT_LE_PARFAIT_JAR = '[Sample] 1 L Le Parfait Jar';
const PRODUCT_DUSTPAN_BRUSH = '[Sample] Dustpan & Brush';

async function expandFilterIfNeeded(page: Page, filterLabel: string) {
  const filterButton = page.getByRole('button', { name: filterLabel });
  const isExpanded = await filterButton.getAttribute('aria-expanded');

  if (isExpanded === 'false') {
    await filterButton.click();
  }
}

async function clickSpecificFilterOption(page: Page, filterName: string, optionName: string) {
  const filterButton = page
    .getByRole('region', { name: filterName })
    .getByRole('checkbox', { name: optionName });

  await filterButton.check();
}

test('Blue color filter updates URL and filtered products on shop-all page', async ({ page }) => {
  await page.goto(SHOP_ALL_URL);

  await expandFilterIfNeeded(page, 'Color');
  await clickSpecificFilterOption(page, 'Color', 'Blue');

  await expect(page).toHaveURL((url) => url.searchParams.get('attr_Color') === 'Blue');
  await expect(page.getByRole('link', { name: PRODUCT_LE_PARFAIT_JAR })).toBeVisible();
});

test('Brand filter updates URL and filtered products on shop-all page', async ({ page }) => {
  await page.goto(SHOP_ALL_URL);

  await expandFilterIfNeeded(page, 'Brand');
  await clickSpecificFilterOption(page, 'Brand', 'OFS');

  await expect(page).toHaveURL((url) => url.searchParams.has('brand'));
  await expect(page.getByRole('link', { name: PRODUCT_DUSTPAN_BRUSH })).toBeVisible();
});

import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test('product editor assigns shared addon groups and POS popup shows their choices and prices', async ({ page }) => {
  test.setTimeout(60_000);
  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const headers = { Authorization: `Bearer ${token}` };
  const suffix = Date.now();
  const productName = `Addon Editor E2E ${suffix}`;
  const groupName = `Addon Group E2E ${suffix}`;
  const choiceName = `Extra E2E ${suffix}`;

  const categoriesResponse = await page.request.get(`${BASE}/api/categories`, { headers });
  expect(categoriesResponse.ok()).toBeTruthy();
  const categoriesPayload = await categoriesResponse.json();
  const category = (categoriesPayload.categories as { id: string; is_active: boolean }[])
    .find((entry) => entry.is_active);
  expect(category, 'E2E database has an active category').toBeTruthy();

  const groupResponse = await page.request.post(`${BASE}/api/addon-groups`, {
    headers,
    data: {
      name: groupName,
      is_required: false,
      min_selection: 0,
      max_selection: 2,
      addons: [{ name: choiceName, price: 1.25, is_active: true }],
    },
  });
  expect(groupResponse.ok()).toBeTruthy();
  const groupId = (await groupResponse.json()).addon_group.id as string;

  const productResponse = await page.request.post(`${BASE}/api/products`, {
    headers,
    data: { name: productName, category_id: category!.id, price: 10, is_active: true },
  });
  expect(productResponse.ok()).toBeTruthy();
  const productId = (await productResponse.json()).product.id as string;

  try {
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');

    await page.goto(`${BASE}/products`);
    await page.getByPlaceholder('Search').fill(productName);
    const productRow = page.getByRole('row').filter({ hasText: productName });
    await expect(productRow).toBeVisible();
    await productRow.locator('button:has(svg.lucide-pencil)').click();
    await expect(page.getByRole('heading', { name: productName, level: 2 })).toBeVisible();

    const groupCheckbox = page.locator('label').filter({ hasText: groupName }).first().locator('input[type="checkbox"]');
    await expect(groupCheckbox).toBeVisible();
    await groupCheckbox.check();
    await expect(page.getByText(choiceName, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit choices & prices' }).click();
    const choicePrice = page.locator('input[aria-label="Price"]');
    await expect(choicePrice).toBeVisible();
    await choicePrice.fill('1.75');
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: productName })).toHaveCount(0);

    const persisted = await page.request.get(`${BASE}/api/products`, { headers });
    expect(persisted.ok()).toBeTruthy();
    const persistedProducts = (await persisted.json()).products as { id: string; addon_groups?: { id: string }[] }[];
    expect(persistedProducts.find((product) => product.id === productId)?.addon_groups?.map((group) => group.id)).toContain(groupId);

    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await page.getByRole('button', { name: `Add ${productName}` }).click({ button: 'right' });
    await expect(page.getByRole('heading', { name: productName, level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: groupName })).toBeVisible();
    await expect(page.getByText(choiceName, { exact: true })).toBeVisible();
    await expect(page.getByText(/1\.75/)).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    await page.goto(`${BASE}/products`);
    await page.getByPlaceholder('Search').fill(productName);
    const savedRow = page.getByRole('row').filter({ hasText: productName });
    await savedRow.locator('button:has(svg.lucide-pencil)').click();
    const assignedCheckbox = page.locator('label').filter({ hasText: groupName }).first().locator('input[type="checkbox"]');
    await expect(assignedCheckbox).toBeChecked();
    await assignedCheckbox.uncheck();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const removed = await page.request.get(`${BASE}/api/products`, { headers });
    const removedProducts = (await removed.json()).products as { id: string; addon_groups?: { id: string }[] }[];
    expect(removedProducts.find((product) => product.id === productId)?.addon_groups?.map((group) => group.id) ?? []).not.toContain(groupId);
  } finally {
    await page.request.put(`${BASE}/api/products/${productId}`, { headers, data: { is_active: false } });
    await page.request.put(`${BASE}/api/addon-groups/${groupId}`, {
      headers,
      data: { name: groupName, is_active: false, min_selection: 0, max_selection: 2, addons: [] },
    });
  }
});

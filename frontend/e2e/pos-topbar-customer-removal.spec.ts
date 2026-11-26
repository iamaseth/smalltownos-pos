import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

function overlaps(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

test('BackStreet table picker stays clickable after selecting a table at 1280px', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const authHeaders = { Authorization: `Bearer ${token}` };
  const businessResponse = await page.request.get(`${BASE}/api/settings/business`, { headers: authHeaders });
  expect(businessResponse.ok()).toBeTruthy();
  const originalBusiness = await businessResponse.json();
  const attemptId = Date.now();
  const tableName = `E2E-TOPBAR-${attemptId}`;
  let tableId: string | undefined;

  try {
    const businessUpdate = await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: { ...originalBusiness, tables_required: true },
    });
    expect(businessUpdate.ok()).toBeTruthy();

    const tableResponse = await page.request.post(`${BASE}/api/tables`, {
      headers: authHeaders,
      data: { number: tableName, capacity: 2 },
    });
    expect(tableResponse.ok()).toBeTruthy();
    tableId = (await tableResponse.json()).table.id;

    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20_000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();

    await page.getByRole('button', { name: 'Table', exact: true }).click();
    const tablePicker = page.locator('div.fixed.inset-0').filter({
      has: page.getByRole('heading', { name: 'Select Table', exact: true }),
    }).last();
    const listView = tablePicker.getByRole('button', { name: 'List', exact: true });
    if (await listView.count()) await listView.click();
    await tablePicker.getByRole('button', { name: new RegExp(tableName) }).click();

    const tableButton = page.getByRole('button', { name: tableName, exact: true });
    await expect(tableButton).toBeVisible();

    const tableBox = await tableButton.boundingBox();
    expect(tableBox).not.toBeNull();
    const orderTypeBox = await page.getByRole('group', { name: 'Order type' }).boundingBox();
    expect(orderTypeBox).not.toBeNull();
    expect(overlaps(orderTypeBox!, tableBox!)).toBe(false);

    await tableButton.click();
    await expect(page.getByRole('heading', { name: 'Select Table', exact: true })).toBeVisible();
  } finally {
    if (tableId) {
      await page.request.post(`${BASE}/api/tables/${tableId}/deactivate`, { headers: authHeaders });
    }
    await page.request.put(`${BASE}/api/settings/business`, {
      headers: authHeaders,
      data: originalBusiness,
    });
  }
});

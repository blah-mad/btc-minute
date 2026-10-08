import { test, expect, devices } from '@playwright/test';

test('signing out returns to guest play and allows signing back in', async ({ page }) => {
  const email = `logout-${Date.now()}@example.com`;
  const password = 'Local-demo-password-42';
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Up Higher price' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save your score' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Logout Demo');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save your score', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Your score: 0', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Up Higher price' })).toBeEnabled();
  await expect(page.getByText('Your previous session could not be restored. Try again to reconnect to your score.')).not.toBeVisible();

  await page.getByRole('button', { name: 'Save your score', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Up Higher price' })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Your score: 0', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save your score', exact: true })).toBeEnabled();
  await expect(page.getByText('Your previous session could not be restored. Try again to reconnect to your score.')).not.toBeVisible();
});

test('a full round survives closing the page and keeps its score after signup', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Up Higher price' })).toBeEnabled();
  await expect(page.getByLabel('Your score: 0', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Up Higher price' }).click();
  await expect(page.getByText('Your prediction', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save your score' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/pending-desktop.png', fullPage: true });
  await page.close();
  // The browser has no open page while the backend continues the original round.
  await new Promise(resolve => setTimeout(resolve, 61_000));
  const returned = await context.newPage();
  returned.on('pageerror', error => errors.push(error.message));
  await returned.goto('/');
  await expect(returned.getByLabel('Your score: 1', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(returned.getByRole('region', { name: 'Last result' })).toContainText('+1 point');
  await returned.getByRole('button', { name: 'Save your score' }).click();
  await returned.getByLabel('Name', { exact: true }).fill('Demo Player');
  await returned.getByLabel('Email', { exact: true }).fill(`player-${Date.now()}@example.com`);
  await returned.getByLabel('Password', { exact: true }).fill('Local-demo-password-42');
  await returned.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(returned.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(returned.getByLabel('Your score: 1', { exact: true })).toBeVisible();
  await returned.reload();
  await expect(returned.getByLabel('Your score: 1', { exact: true })).toBeVisible();
  await returned.screenshot({ path: 'test-results/result-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('mobile layout, keyboard dialog and price outage', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone SE'], viewport: { width: 320, height: 680 }, baseURL: 'http://127.0.0.1:5174' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Up Higher price' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-320.png', fullPage: true });
  await page.getByRole('button', { name: 'Down Lower price' }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('Your score: 0', { exact: true })).toBeInViewport();
  await expect(page.locator('.header-quote')).toBeInViewport();
  await page.screenshot({ path: 'test-results/mobile-scrolled.png' });
  await page.getByRole('button', { name: 'Save your score' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-dialog.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.route('**/api/price', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'PRICE_UNAVAILABLE', error: 'Market data temporarily unavailable.' }) }));
  await expect(page.getByText('Price updates are unavailable. Reconnecting automatically.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Up Higher price' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/mobile-price-outage.png', fullPage: true });
  await context.close();
});

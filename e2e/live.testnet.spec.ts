import { expect, test } from '@playwright/test';

const LIVE_ENABLED = process.env.PW_E2E_LIVE === '1';
const LIVE_TOPUP_IDENTITY_ID = process.env.PW_LIVE_TOPUP_IDENTITY_ID;
const LIVE_DPNS_IDENTITY_ID = process.env.PW_LIVE_DPNS_IDENTITY_ID;
const LIVE_DPNS_PRIVATE_KEY_WIF = process.env.PW_LIVE_DPNS_PRIVATE_KEY_WIF;
const LIVE_MANAGE_IDENTITY_ID = process.env.PW_LIVE_MANAGE_IDENTITY_ID;
const LIVE_MANAGE_PRIVATE_KEY_WIF = process.env.PW_LIVE_MANAGE_PRIVATE_KEY_WIF;

test.describe('Live testnet E2E (optional)', () => {
  test.skip(!LIVE_ENABLED, 'Set PW_E2E_LIVE=1 to enable live testnet checks');

  test('create mode renders real deposit details on testnet', async ({ page }) => {
    await page.goto('/?network=testnet&e2e=live');

    await page.click('#mode-create-btn');
    await page.click('#continue-btn');

    await expect(page.locator('.deposit-headline')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Request Testnet Funds' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.address')).toBeVisible({ timeout: 15000 });
  });

  test('top up mode validates and renders testnet deposit step', async ({ page }) => {
    test.skip(!LIVE_TOPUP_IDENTITY_ID, 'Set PW_LIVE_TOPUP_IDENTITY_ID to run top-up live check');

    await page.goto('/?network=testnet&e2e=live');

    await page.click('#mode-topup-btn');
    await page.fill('#identity-id-input', LIVE_TOPUP_IDENTITY_ID!);
    await page.click('#continue-topup-btn');

    await expect(page.locator('.deposit-headline')).toContainText('Top up', { timeout: 15000 });
    await expect(page.locator('.address')).toBeVisible({ timeout: 15000 });
  });

  test('dpns existing identity key validation works against testnet', async ({ page }) => {
    test.skip(
      !LIVE_DPNS_IDENTITY_ID || !LIVE_DPNS_PRIVATE_KEY_WIF,
      'Set PW_LIVE_DPNS_IDENTITY_ID and PW_LIVE_DPNS_PRIVATE_KEY_WIF to run DPNS live check'
    );

    await page.goto('/?network=testnet&e2e=live');

    await page.click('#mode-dpns-btn');
    await page.click('#dpns-choose-existing-btn');

    await page.fill('#dpns-identity-id-input', LIVE_DPNS_IDENTITY_ID!);
    await page.locator('#dpns-identity-id-input').press('Tab');

    await expect(page.locator('.identity-status.success')).toContainText('Identity found with', { timeout: 90000 });

    await page.fill('#dpns-private-key-input', LIVE_DPNS_PRIVATE_KEY_WIF!);
    await page.locator('#dpns-private-key-input').press('Tab');

    await expect(page.locator('.key-status.success')).toContainText('Key matches key', { timeout: 30000 });
    await expect(page.locator('#dpns-identity-continue-btn')).toBeEnabled();
  });

  test('manage identity key validation works against testnet', async ({ page }) => {
    test.skip(
      !LIVE_MANAGE_IDENTITY_ID || !LIVE_MANAGE_PRIVATE_KEY_WIF,
      'Set PW_LIVE_MANAGE_IDENTITY_ID and PW_LIVE_MANAGE_PRIVATE_KEY_WIF to run manage live check'
    );

    await page.goto('/?network=testnet&e2e=live');

    await page.click('#mode-manage-btn');
    await page.fill('#manage-identity-id-input', LIVE_MANAGE_IDENTITY_ID!);
    await page.locator('#manage-identity-id-input').press('Tab');

    await expect(page.locator('.identity-status.success')).toContainText('Identity found with', { timeout: 90000 });

    await page.fill('#manage-private-key-input', LIVE_MANAGE_PRIVATE_KEY_WIF!);
    await page.locator('#manage-private-key-input').press('Tab');

    await expect(page.locator('.key-status.success')).toContainText('MASTER level', { timeout: 30000 });
    await expect(page.locator('#manage-identity-continue-btn')).toBeEnabled();
  });
});

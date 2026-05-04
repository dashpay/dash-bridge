import { expect, test } from '@playwright/test';
import {
  E2E_MOCK_DPNS_WIF,
  E2E_MOCK_IDENTITY_ID,
  E2E_MOCK_MANAGE_WIF,
} from '../src/e2e-mock-constants';

const MOCK_QUERY = '/?network=testnet&e2e=mock';

test.describe('Deterministic UI E2E (mock mode)', () => {
  test('create identity flow transitions to completion and DPNS registration', async ({ page }) => {
    await page.goto(MOCK_QUERY);

    await page.click('#mode-create-btn');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();

    await page.click('#continue-btn');

    await expect(page.locator('.deposit-headline')).toBeVisible();
    await expect.poll(async () => {
      return page.evaluate(() => typeof (window as { __e2eMockAdvance?: () => void }).__e2eMockAdvance);
    }).toBe('function');
    await page.evaluate(() => (window as { __e2eMockAdvance?: () => void }).__e2eMockAdvance?.());

    await expect(page.getByText('Save your keys')).toBeVisible();
    await expect(page.locator('.contract-id-section', { hasText: 'Your Identity ID' }).locator('.identity-id')).toHaveText(E2E_MOCK_IDENTITY_ID);

    await page.click('#dpns-from-identity-btn');
    await expect(page.getByText('Choose Your Usernames')).toBeVisible();

    const usernameInput = page.locator('.dpns-username-input').first();
    await usernameInput.fill('alpha');
    await page.click('#check-availability-btn');

    await expect(page.getByText('Review Usernames')).toBeVisible();
    await expect(page.getByText('Available (Contested)')).toBeVisible();
    await expect(page.locator('#dpns-contested-checkbox')).toBeVisible();
    await expect(page.locator('#register-dpns-btn')).toBeDisabled();

    await page.locator('#dpns-contested-checkbox').click({ force: true });
    await expect(page.locator('#register-dpns-btn')).toBeEnabled();

    await page.click('#register-dpns-btn');
    await expect(page.getByText('Registration Complete!')).toBeVisible();
  });

  test('top up flow validates identity input and reaches completion', async ({ page }) => {
    await page.goto(MOCK_QUERY);

    await page.click('#mode-topup-btn');
    await expect(page.locator('#identity-id-input')).toBeVisible();

    await page.click('#continue-topup-btn');
    await expect(page.locator('#validation-msg')).toContainText('Please enter a valid identity ID');

    await page.fill('#identity-id-input', E2E_MOCK_IDENTITY_ID);
    await page.click('#continue-topup-btn');

    await expect(page.locator('.deposit-headline')).toBeVisible();
    await expect.poll(async () => {
      return page.evaluate(() => typeof (window as { __e2eMockAdvance?: () => void }).__e2eMockAdvance);
    }).toBe('function');
    await page.evaluate(() => (window as { __e2eMockAdvance?: () => void }).__e2eMockAdvance?.());

    await expect(page.getByText('Top-up complete!')).toBeVisible();
    await expect(page.locator('.contract-id-section', { hasText: 'Identity ID' }).locator('.identity-id')).toHaveText(E2E_MOCK_IDENTITY_ID);
  });

  test('manage identity flow validates key and applies changes', async ({ page }) => {
    await page.goto(MOCK_QUERY);

    await page.click('#mode-manage-btn');
    await expect(page.locator('#manage-identity-id-input')).toBeVisible();

    await page.fill('#manage-identity-id-input', E2E_MOCK_IDENTITY_ID);
    await page.locator('#manage-identity-id-input').press('Tab');
    await expect(page.getByText('Identity found with 2 keys')).toBeVisible();

    await page.fill('#manage-private-key-input', 'bad-key');
    await page.locator('#manage-private-key-input').press('Tab');
    await expect(page.getByText('Mock mode: use the configured test private key')).toBeVisible();

    await page.fill('#manage-private-key-input', E2E_MOCK_MANAGE_WIF);
    await page.locator('#manage-private-key-input').blur();
    await expect(page.getByText('Manage Keys')).toBeVisible();

    await page.click('#add-manage-key-btn');
    await page.locator('.manage-disable-key-checkbox').first().click({ force: true });
    await expect(page.getByText('Will add 1 key, disable 1 key')).toBeVisible();

    await page.click('#apply-manage-btn');
    await expect(page.getByText('Update Complete!')).toBeVisible();
  });

  test('standalone DPNS flow validates identity + key and completes registration', async ({ page }) => {
    await page.goto(MOCK_QUERY);

    await page.click('#mode-dpns-btn');
    await expect(page.getByText('Register a Username')).toBeVisible();

    await page.click('#dpns-choose-existing-btn');
    await expect(page.locator('#dpns-identity-id-input')).toBeVisible();

    await page.fill('#dpns-identity-id-input', E2E_MOCK_IDENTITY_ID);
    await page.locator('#dpns-identity-id-input').press('Tab');
    await expect(page.getByText('Identity found with 2 keys')).toBeVisible();

    await page.fill('#dpns-private-key-input', E2E_MOCK_DPNS_WIF);
    await page.locator('#dpns-private-key-input').press('Tab');
    await expect(page.getByText('Key matches key #1 (CRITICAL level)')).toBeVisible();

    await page.click('#dpns-identity-continue-btn');
    await expect(page.getByText('Choose Your Usernames')).toBeVisible();

    await page.locator('.dpns-username-input').first().fill('noncontested123456789012345');
    await page.click('#check-availability-btn');

    await expect(page.getByText('Review Usernames')).toBeVisible();
    await expect(page.locator('#register-dpns-btn')).toBeEnabled();

    await page.click('#register-dpns-btn');
    await expect(page.getByText('Registration Complete!')).toBeVisible();
  });
});

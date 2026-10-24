import { expect, test, type Page } from '@playwright/test';
import { bech32m } from '@scure/base';
import {
  E2E_MOCK_DPNS_WIF,
  E2E_MOCK_IDENTITY_ID,
  E2E_MOCK_MANAGE_WIF,
  E2E_MOCK_WITHDRAW_WIF,
  E2E_MOCK_WITHDRAW_ADDRESS,
  E2E_MOCK_XFER_MNEMONIC,
  E2E_MOCK_XFER_RECIPIENT_ID,
} from '../src/e2e-mock-constants';

const MOCK_QUERY = '/?network=testnet&e2e=mock';

/** Failure injection read by the mock flows (E2EMockFailures in src/main.ts). */
function injectMockFailures(page: Page, failures: { sdkLoadFailures?: number; submissionFailures?: number }) {
  return page.addInitScript((f) => {
    (window as { __e2eMockFailures?: typeof f }).__e2eMockFailures = f;
  }, failures);
}

/** Pretend the deposit arrived (the mock flows wait for this hook). */
async function advanceMockDeposit(page: Page) {
  await expect.poll(async () => {
    return page.evaluate(() => typeof (window as { __e2eMockAdvance?: () => void }).__e2eMockAdvance);
  }).toBe('function');
  await page.evaluate(() => (window as { __e2eMockAdvance?: () => void }).__e2eMockAdvance?.());
}

test.describe('Deterministic UI E2E (mock mode)', () => {
  test('testnet discovers evonodes from the quorum service, never calls digitalcash.dev and does not load the SDK for the health poll', async ({ page }) => {
    const digitalcashRequests: string[] = [];
    const sdkRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (/(^|\.)digitalcash\.dev$/.test(url.hostname)) digitalcashRequests.push(request.url());
      // The EvoSDK bundle/wasm must not be fetched just to draw the health indicator.
      if (/evo-sdk|wasm[-_]sdk/i.test(url.pathname)) sdkRequests.push(request.url());
    });
    await page.route('https://quorums.testnet.networks.dash.org/masternodes', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          success: true,
          data: [1, 2, 3].map((n) => ({
            address: `203.0.113.${n}:19999`,
            status: 'ENABLED',
            versionCheck: 'success',
          })),
        }),
      })
    );

    // Client init (warmup) fetches the evonode list and starts network-status polling.
    const evonodeRequest = page.waitForRequest('https://quorums.testnet.networks.dash.org/masternodes', {
      timeout: 15000,
    });
    await page.goto(MOCK_QUERY);
    await evonodeRequest;
    // Let the first network-status poll (Insight + Platform status) go out.
    await page.waitForTimeout(2000);

    expect(digitalcashRequests).toEqual([]);
    expect(sdkRequests).toEqual([]);
  });

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

  test.describe('Platform component gate before funding', () => {
    test('a dropped SDK download is retried and the flow reaches the deposit address', async ({ page }) => {
      const warnings: string[] = [];
      const events: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'warning') warnings.push(msg.text());
        if (msg.text().includes('Chunk "evo-sdk" failed to load')) events.push('sdk-failure');
      });
      // The key backup download must wait for the gate: on iOS its prompt
      // cancels in-flight loads (that poisoned the SDK import in production).
      page.on('download', () => events.push('backup-download'));
      await injectMockFailures(page, { sdkLoadFailures: 2 });
      await page.goto(MOCK_QUERY);
      await page.click('#mode-create-btn');
      await page.click('#continue-btn');

      // The retries' backoff (0.5 + 1.5 s) keeps the gate on screen.
      await expect(page.locator('.preparing-step')).toContainText('Preparing…');
      await expect(page.locator('.deposit-headline')).toBeVisible();
      expect(warnings.filter((w) => w.includes('Chunk "evo-sdk" failed to load'))).toHaveLength(2);
      await expect.poll(() => events).toEqual(['sdk-failure', 'sdk-failure', 'backup-download']);
    });

    for (const flow of ['create', 'topup'] as const) {
      test(`${flow}: an SDK that cannot load stops the flow before any deposit address, with Reload`, async ({ page }) => {
        let downloads = 0;
        page.on('download', () => { downloads += 1; });
        await injectMockFailures(page, { sdkLoadFailures: 3 });
        await page.goto(MOCK_QUERY);
        if (flow === 'create') {
          await page.click('#mode-create-btn');
          await page.click('#continue-btn');
        } else {
          await page.click('#mode-manage-btn');
          await page.click('#manage-action-topup-btn');
          await page.fill('#identity-id-input', E2E_MOCK_IDENTITY_ID);
          await page.click('#continue-topup-btn');
        }

        await expect(page.locator('.error-code-badge')).toHaveText('ERR-1017');
        await expect(page.locator('.error-step')).toContainText('The page failed to load a required component "evo-sdk"');
        await expect(page.locator('.error-step')).toContainText('No funds have been sent');
        await expect(page.locator('.deposit-headline')).toHaveCount(0);
        await expect(page.locator('#download-keys-btn')).toHaveCount(0);
        expect(downloads).toBe(0);
        await page.locator('.error-technical summary').click();
        await expect(page.locator('.error-technical-content')).toContainText('Failed to load: evo-sdk');

        // Reload is safe here: nothing was funded. The reloaded page starts over.
        await page.click('#reload-page-btn');
        await expect(page.locator('#mode-create-btn')).toBeVisible();
      });
    }

    test('registration failing after the lock arrived says so, and Retry Registration completes it', async ({ page }) => {
      await injectMockFailures(page, { submissionFailures: 1 });
      await page.goto(MOCK_QUERY);
      await page.click('#mode-create-btn');
      await page.click('#continue-btn');
      await expect(page.locator('.deposit-headline')).toBeVisible();
      await advanceMockDeposit(page);

      const errorStep = page.locator('.error-step');
      await expect(page.locator('.error-code-badge')).toHaveText('ERR-1006');
      await expect(errorStep).toContainText('the InstantSend lock arrived');
      await expect(errorStep).not.toContainText("InstantSend didn't go through");
      await expect(page.locator('#download-keys-btn')).toBeVisible();

      await page.click('#retry-registration-btn');
      await expect(page.getByText('Save your keys')).toBeVisible();
      await expect(page.locator('.contract-id-section', { hasText: 'Your Identity ID' }).locator('.identity-id')).toHaveText(E2E_MOCK_IDENTITY_ID);
    });

    test('top-up failing after the lock arrived offers Retry Top-up, which completes it', async ({ page }) => {
      await injectMockFailures(page, { submissionFailures: 1 });
      await page.goto(MOCK_QUERY);
      await page.click('#mode-manage-btn');
      await page.click('#manage-action-topup-btn');
      await page.fill('#identity-id-input', E2E_MOCK_IDENTITY_ID);
      await page.click('#continue-topup-btn');
      await expect(page.locator('.deposit-headline')).toBeVisible();
      await advanceMockDeposit(page);

      await expect(page.locator('.error-code-badge')).toHaveText('ERR-1007');
      await expect(page.locator('#retry-registration-btn')).toHaveText('Retry Top-up');
      await page.click('#retry-registration-btn');
      await expect(page.getByText('Top-up complete!')).toBeVisible();
    });
  });

  test('top up flow validates identity input and reaches completion', async ({ page }) => {
    await page.goto(MOCK_QUERY);

    await page.click('#mode-manage-btn');
    await page.click('#manage-action-topup-btn');
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

  test('manage identity menu gathers the identity operations and Back returns to it', async ({ page }) => {
    await page.goto(MOCK_QUERY);

    // The init screen no longer carries these as separate entries.
    await expect(page.locator('#mode-topup-btn')).toHaveCount(0);
    await expect(page.locator('#mode-withdraw-btn')).toHaveCount(0);

    await page.click('#mode-manage-btn');
    for (const id of ['topup', 'keys', 'transfer', 'withdraw']) {
      await expect(page.locator(`#manage-action-${id}-btn`)).toBeVisible();
    }

    // Back out of top-up returns to the menu, not the init screen.
    await page.click('#manage-action-topup-btn');
    await expect(page.locator('#identity-id-input')).toBeVisible();
    await page.click('#back-btn');
    await expect(page.locator('#manage-action-topup-btn')).toBeVisible();

    // Same for withdraw, which has its own back button.
    await page.click('#manage-action-withdraw-btn');
    await expect(page.locator('#withdraw-identity-id-input')).toBeVisible();
    await page.click('#withdraw-back-btn');
    await expect(page.locator('#manage-action-withdraw-btn')).toBeVisible();

    // And Back from the menu itself leaves for the init screen.
    await page.click('#back-btn');
    await expect(page.locator('#mode-create-btn')).toBeVisible();
  });

  test('deep-linked withdraw goes back to init, not the manage menu', async ({ page }) => {
    await page.goto('/?network=testnet&e2e=mock&mode=withdraw');
    await expect(page.locator('#withdraw-identity-id-input')).toBeVisible();

    await page.click('#withdraw-back-btn');
    await expect(page.locator('#mode-create-btn')).toBeVisible();
    await expect(page.locator('#manage-action-withdraw-btn')).toHaveCount(0);
  });

  test('manage identity flow validates key and applies changes', async ({ page }) => {
    await page.goto(MOCK_QUERY);

    await page.click('#mode-manage-btn');
    await expect(page.locator('#manage-action-keys-btn')).toBeVisible();

    await page.click('#manage-action-keys-btn');
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

  test('withdraw flow validates inputs and completes with status tracking', async ({ page }) => {
    await page.goto(MOCK_QUERY);

    await page.click('#mode-manage-btn');
    await page.click('#manage-action-withdraw-btn');
    await expect(page.locator('#withdraw-identity-id-input')).toBeVisible();

    // Invalid identity ID is rejected
    await page.fill('#withdraw-identity-id-input', 'nope');
    await page.locator('#withdraw-identity-id-input').press('Tab');
    await expect(page.getByText(/Invalid identity ID/)).toBeVisible();

    // Valid identity advances to configure with the balance shown
    await page.fill('#withdraw-identity-id-input', E2E_MOCK_IDENTITY_ID);
    await page.locator('#withdraw-identity-id-input').press('Tab');
    await expect(page.getByText('Configure Withdrawal')).toBeVisible();
    await expect(page.locator('.withdraw-balance')).toContainText('0.25 DASH');

    // Wrong WIF is rejected, the mock WIF validates as a TRANSFER key
    await page.fill('#withdraw-private-key-input', 'bad-key');
    await page.locator('#withdraw-private-key-input').press('Tab');
    await expect(page.getByText('Mock mode: use the configured test private key')).toBeVisible();

    await page.fill('#withdraw-private-key-input', E2E_MOCK_WITHDRAW_WIF);
    await page.locator('#withdraw-private-key-input').press('Tab');
    await expect(page.getByText('Key matches key #3 (TRANSFER / CRITICAL)')).toBeVisible();

    // Bad address is rejected (real validation runs even in mock mode)
    await page.fill('#withdraw-address-input', 'not-an-address');
    await page.locator('#withdraw-address-input').press('Tab');
    await expect(page.locator('#withdraw-address-error')).toBeVisible();

    await page.fill('#withdraw-address-input', E2E_MOCK_WITHDRAW_ADDRESS);
    await page.locator('#withdraw-address-input').press('Tab');
    await expect(page.locator('#withdraw-address-error')).toHaveCount(0);

    // Amount below the minimum, above the balance, then valid
    await page.fill('#withdraw-amount-input', '0.000001');
    await page.locator('#withdraw-amount-input').press('Tab');
    await expect(page.locator('#withdraw-amount-error')).toContainText('Minimum withdrawal');

    await page.fill('#withdraw-amount-input', '1');
    await page.locator('#withdraw-amount-input').press('Tab');
    await expect(page.locator('#withdraw-amount-error')).toContainText('exceeds your balance');
    await expect(page.locator('#withdraw-submit-btn')).toBeDisabled();

    await page.fill('#withdraw-amount-input', '0.1');
    await page.locator('#withdraw-amount-input').press('Tab');
    await expect(page.locator('#withdraw-amount-credits')).toContainText('10,000,000,000 credits');
    await expect(page.locator('#withdraw-submit-btn')).toBeEnabled();

    // Submit walks the mock status sequence to completion
    await page.click('#withdraw-submit-btn');
    await expect(page.getByText('Withdrawal Complete!')).toBeVisible();
    const details = page.locator('.withdraw-success-details');
    await expect(details).toContainText('Amount: 0.1 DASH');
    await expect(details).toContainText(E2E_MOCK_WITHDRAW_ADDRESS);
    await expect(details).toContainText('Remaining balance: 0.15 DASH');
  });

  /** Deep-link into withdraw with scripted landed-check verdicts and fill a valid form. */
  async function fillWithdrawForm(page: import('@playwright/test').Page, checks: string) {
    await page.goto(`${MOCK_QUERY}&mode=withdraw&e2eWithdrawChecks=${checks}`);
    await page.fill('#withdraw-identity-id-input', E2E_MOCK_IDENTITY_ID);
    await page.locator('#withdraw-identity-id-input').press('Tab');
    await expect(page.getByText('Configure Withdrawal')).toBeVisible();
    await page.fill('#withdraw-private-key-input', E2E_MOCK_WITHDRAW_WIF);
    await page.locator('#withdraw-private-key-input').press('Tab');
    await page.fill('#withdraw-address-input', E2E_MOCK_WITHDRAW_ADDRESS);
    await page.locator('#withdraw-address-input').press('Tab');
    await page.fill('#withdraw-amount-input', '0.1');
    await page.locator('#withdraw-amount-input').press('Tab');
    await expect(page.locator('#withdraw-submit-btn')).toBeEnabled();
  }

  test('withdraw with an unknown outcome blocks retry until a check confirms it did not land', async ({ page }) => {
    await fillWithdrawForm(page, 'unknown,unknown,not_found');
    await page.click('#withdraw-submit-btn');

    await expect(page.getByText('Withdrawal Outcome Unknown')).toBeVisible();
    await expect(page.locator('.withdraw-unknown-warning')).toContainText("Don't retry until you've confirmed");
    await expect(page.locator('#withdraw-retry-btn')).toHaveCount(0);
    await expect(page.locator('#withdraw-start-over-btn')).toBeVisible();

    // Still unknown: no retry yet
    await page.click('#withdraw-check-again-btn');
    await expect(page.locator('#withdraw-check-again-btn')).toHaveText('Check Again');
    await expect(page.getByText('Withdrawal Outcome Unknown')).toBeVisible();
    await expect(page.locator('#withdraw-retry-btn')).toHaveCount(0);

    // Confirmed not landed: the normal, retryable failure screen
    await page.click('#withdraw-check-again-btn');
    await expect(page.getByText('Withdrawal Failed')).toBeVisible();
    await expect(page.locator('#withdraw-check-again-btn')).toHaveCount(0);
    await page.click('#withdraw-retry-btn');
    await expect(page.getByText('Configure Withdrawal')).toBeVisible();
  });

  test('withdraw with an unknown outcome switches to tracking once the withdrawal is found', async ({ page }) => {
    await fillWithdrawForm(page, 'unknown,found');
    await page.click('#withdraw-submit-btn');

    await expect(page.getByText('Withdrawal Outcome Unknown')).toBeVisible();
    await page.click('#withdraw-check-again-btn');
    await expect(page.getByText('Withdrawal Complete!')).toBeVisible();
    await expect(page.locator('#withdraw-retry-btn')).toHaveCount(0);
  });

  test('withdraw error confirmed not landed stays retryable', async ({ page }) => {
    await fillWithdrawForm(page, 'not_found');
    await page.click('#withdraw-submit-btn');

    await expect(page.getByText('Withdrawal Failed')).toBeVisible();
    await expect(page.locator('#withdraw-retry-btn')).toBeVisible();
    await expect(page.locator('#withdraw-check-again-btn')).toHaveCount(0);
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

  test('username transfer flow discovers the identity from a seed phrase and completes', async ({ page }) => {
    await page.goto(MOCK_QUERY);

    await page.click('#mode-manage-btn');
    await page.click('#manage-action-transfer-btn');
    await expect(page.locator('#xfer-mnemonic-input')).toBeVisible();

    // A phrase that fails the BIP39 checksum is rejected before any lookup.
    await page.fill('#xfer-mnemonic-input', 'abandon abandon abandon');
    await page.click('#xfer-unlock-btn');
    await expect(page.getByText('That is not a valid BIP39 seed phrase.')).toBeVisible();

    await page.fill('#xfer-mnemonic-input', E2E_MOCK_XFER_MNEMONIC);
    await page.click('#xfer-unlock-btn');

    await expect(page.getByText('Signing with key #1 (HIGH level)')).toBeVisible();
    await expect(page.locator('.xfer-username-option')).toHaveCount(2);
    await expect(page.locator('#xfer-select-continue-btn')).toBeDisabled();

    await page.locator('.xfer-username-radio').first().click({ force: true });

    // A malformed destination is rejected without a network round trip.
    await page.fill('#xfer-recipient-input', 'not-an-identity');
    await page.locator('#xfer-recipient-input').blur();
    await expect(page.getByText(/Invalid identity ID/)).toBeVisible();

    // Transferring to yourself is a no-op the SDK would reject anyway.
    await page.fill('#xfer-recipient-input', E2E_MOCK_IDENTITY_ID);
    await page.locator('#xfer-recipient-input').blur();
    await expect(page.getByText('This is the identity that already owns the username')).toBeVisible();
    await expect(page.locator('#xfer-select-continue-btn')).toBeDisabled();

    await page.fill('#xfer-recipient-input', E2E_MOCK_XFER_RECIPIENT_ID);
    await page.locator('#xfer-recipient-input').blur();
    await expect(page.getByText('Destination identity found')).toBeVisible();
    await expect(page.locator('#xfer-select-continue-btn')).toBeEnabled();

    await page.click('#xfer-select-continue-btn');
    await expect(page.getByText('Confirm Transfer')).toBeVisible();
    await expect(page.locator('#xfer-transfer-btn')).toBeDisabled();

    await page.locator('#xfer-confirm-checkbox').click({ force: true });
    await expect(page.locator('#xfer-transfer-btn')).toBeEnabled();

    await page.click('#xfer-transfer-btn');
    await expect(page.getByText('Username Transferred!')).toBeVisible();
    await expect(
      page.locator('.contract-id-section', { hasText: 'New Owner' }).locator('.identity-id')
    ).toHaveText(E2E_MOCK_XFER_RECIPIENT_ID);
  });
});

test.describe('Untrusted strings are never rendered as markup (mock mode)', () => {
  test.describe.configure({ timeout: 90_000 });

  /** Breaks out of a double-quoted attribute and sets a sentinel if it runs. */
  const ATTR_PAYLOAD = '"><img src=x onerror="window.__xss=1">';
  /** A structurally valid compressed testnet WIF (not used for anything real). */
  const VALID_WIF = 'cMpMxK92W1DjqDvWV3pMn4xLwAuQJhNF3MFqkEHUQRPQofUJku8R';

  const IMPORT_FLOWS = [
    { name: 'DPNS', open: ['#mode-dpns-btn', '#dpns-choose-existing-btn'], prefix: 'dpns' },
    { name: 'Manage Identity', open: ['#mode-manage-btn', '#manage-action-keys-btn'], prefix: 'manage' },
    { name: 'Contract registration', open: ['#mode-contract-btn', '#contract-choose-existing-btn'], prefix: 'contract' },
  ];

  function backupFile(identityId: string, privateKeyWif: string) {
    return {
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        network: 'testnet',
        mode: 'create',
        identityId,
        identityKeys: [{ id: 1, purpose: 'AUTHENTICATION', securityLevel: 'HIGH', privateKeyWif }],
      })),
    };
  }

  /**
   * Load the app with external requests blocked, then wait for the first
   * network-status snapshot. That snapshot re-renders the page, which would
   * otherwise wipe DOM-only messages (upload status, validation text) mid-test.
   */
  async function openApp(page: import('@playwright/test').Page) {
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
    await page.goto(MOCK_QUERY);
    // Polling starts after the idle-time SDK warmup, which is slow on a cold dev server.
    await expect(page.locator('.net-status')).toBeVisible({ timeout: 45_000 });
  }

  async function expectNoInjection(page: import('@playwright/test').Page) {
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
  }

  for (const flow of IMPORT_FLOWS) {
    for (const [field, identityId, wif] of [
      ['identity ID', ATTR_PAYLOAD, VALID_WIF],
      ['private key WIF', E2E_MOCK_IDENTITY_ID, ATTR_PAYLOAD],
    ] as const) {
      test(`${flow.name} key backup import rejects markup in the ${field}`, async ({ page }) => {
        await openApp(page);
        for (const selector of flow.open) await page.click(selector);

        await page.setInputFiles(`#${flow.prefix}-key-upload`, backupFile(identityId, wif));

        await expect(page.locator(`#${flow.prefix}-key-upload-status`)).toHaveText('No identity or keys found in file');
        await expect(page.locator(`#${flow.prefix}-identity-id-input`)).toHaveValue('');
        await expect(page.locator(`#${flow.prefix}-private-key-input`)).toHaveValue('');
        await expectNoInjection(page);
      });
    }

    test(`${flow.name} key backup import still accepts a valid backup`, async ({ page }) => {
      await openApp(page);
      for (const selector of flow.open) await page.click(selector);

      await page.setInputFiles(`#${flow.prefix}-key-upload`, backupFile(E2E_MOCK_IDENTITY_ID, VALID_WIF));

      await expect(page.locator(`#${flow.prefix}-identity-id-input`)).toHaveValue(E2E_MOCK_IDENTITY_ID);
      await expect(page.locator(`#${flow.prefix}-private-key-input`)).toHaveValue(VALID_WIF);
    });
  }

  test('top-up identity input re-renders markup as an inert value', async ({ page }) => {
    await openApp(page);
    await page.click('#mode-manage-btn');
    await page.click('#manage-action-topup-btn');

    await page.fill('#identity-id-input', ATTR_PAYLOAD);

    await expect(page.locator('#identity-id-input')).toHaveValue(ATTR_PAYLOAD);
    await expectNoInjection(page);

    await page.click('#continue-topup-btn');
    await expect(page.locator('#validation-msg')).toContainText('Please enter a valid identity ID');
    await expectNoInjection(page);
  });

  test('faucet response with a markup txid is treated as an error', async ({ page }) => {
    await openApp(page);
    // Registered after openApp's catch-all abort, so these take precedence.
    await page.route('https://faucet.thepasta.org/api/status', (route) =>
      route.fulfill({ json: { status: 'ok' } }));
    await page.route('https://faucet.thepasta.org/api/core-faucet', (route) =>
      route.fulfill({ json: { txid: ATTR_PAYLOAD, amount: 1, address: 'y' } }));

    await page.click('#mode-create-btn');
    await page.click('#continue-btn');
    await page.click('#request-faucet-btn');

    await expect(page.locator('.faucet-error')).toContainText('The faucet accepted the request but returned an invalid transaction ID');
    await expect(page.locator('.faucet-success')).toHaveCount(0);
    await expectNoInjection(page);
  });
});

test.describe('Pay with other crypto via NEAR Intents (mainnet, mock mode, stubbed 1Click API)', () => {
  const ONE_CLICK = 'https://1click.chaindefuser.com';
  const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
  const NEAR_DEPOSIT_ADDRESS = '0x76b4c56085ED136a8744D52bE956396624a730E8';
  const REFUND = '0x2527D02599Ba641c19FEa793cD0F167589a0f10D';
  const TOKENS = [
    { assetId: 'nep141:dash.omft.near', decimals: 8, blockchain: 'dash', symbol: 'DASH', price: 53.17 },
    { assetId: USDC_ETH, decimals: 6, blockchain: 'eth', symbol: 'USDC', price: 1 },
    { assetId: 'nep141:sol.omft.near', decimals: 9, blockchain: 'sol', symbol: 'SOL', price: 150 },
  ];

  /** Block everything external, then stub the 1Click API. Returns the quote requests seen. */
  async function stubOneClick(page: import('@playwright/test').Page, quote: 'ok' | 'no-liquidity', statuses: string[] = []) {
    const quoteBodies: Record<string, unknown>[] = [];
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
    await page.route(`${ONE_CLICK}/v0/tokens`, (route) => route.fulfill({ json: TOKENS }));
    await page.route(`${ONE_CLICK}/v0/quote`, (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      quoteBodies.push(body);
      if (quote === 'no-liquidity') {
        return route.fulfill({ status: 400, json: { message: 'No liquidity available', correlationId: 'c1' } });
      }
      const exactInput = body.swapType === 'EXACT_INPUT';
      return route.fulfill({
        status: 201,
        json: {
          quote: {
            ...(exactInput
              ? { amountIn: body.amount, amountInUsd: '20.00', minAmountIn: body.amount, amountOut: '39400815', amountOutUsd: '19.82', minAmountOut: '39006806', timeEstimate: 177 }
              : { amountIn: '2680000', amountInUsd: '2.68', minAmountIn: '2650000', amountOut: body.amount, amountOutUsd: '2.65', minAmountOut: body.amount, timeEstimate: 134 }),
            ...(body.dry ? {} : { depositAddress: NEAR_DEPOSIT_ADDRESS, deadline: body.deadline }),
          },
          quoteRequest: body,
          signature: 'ed25519:stub',
          correlationId: '05fe5cd8-6d68-47e7-9247-3098905014db',
        },
      });
    });
    await page.route(`${ONE_CLICK}/v0/status?**`, (route) =>
      route.fulfill({ json: { status: statuses.length > 1 ? statuses.shift() : statuses[0] ?? 'PENDING_DEPOSIT' } }));
    return quoteBodies;
  }

  async function openDepositScreen(page: import('@playwright/test').Page) {
    await page.goto('/?network=mainnet&e2e=mock');
    await page.click('#mode-create-btn');
    // Mainnet creation recommends the DashPay app first; continue in the browser.
    await page.locator('#mobile-app-ack-checkbox').check();
    await page.click('#mobile-app-continue-browser-btn');
    await page.click('#continue-btn');
    await expect(page.locator('.deposit-headline')).toBeVisible();
    return (await page.locator('.address-section .address').textContent())!.trim();
  }

  test('prices a swap live, opens it with the refund address and follows it to delivery', async ({ page }) => {
    const quoteBodies = await stubOneClick(page, 'ok', ['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS']);
    const depositAddress = await openDepositScreen(page);
    expect(depositAddress).toMatch(/^X/);

    await page.click('#deposit-tab-near');
    // The DASH QR and address give way to the swap form.
    await expect(page.locator('.address-section')).toHaveCount(0);
    await expect(page.locator('#near-asset-btn')).toContainText('USDC');
    await expect(page.locator('#near-amount-out')).toHaveValue('0.05');

    // The default amount is priced without any click, using a placeholder refund target.
    await expect(page.locator('#near-amount-in')).toHaveValue('2.68');
    await expect(page.locator('#near-intents-quote')).toContainText('1 DASH ≈ 53.60 USDC');
    expect(quoteBodies[0]).toMatchObject({
      dry: true,
      swapType: 'EXACT_OUTPUT',
      originAsset: USDC_ETH,
      destinationAsset: 'nep141:dash.omft.near',
      amount: '5000000',
      recipient: depositAddress,
      refundTo: 'intents.near',
      refundType: 'INTENTS',
    });

    // The refund address is required before a payment address is handed out.
    await page.click('#near-confirm-btn');
    await expect(page.locator('.near-refund-error')).toContainText('Enter an address on the source chain');
    const quotesBeforeConfirm = quoteBodies.length;
    await page.fill('#near-refund-input', REFUND);
    await page.click('#near-confirm-btn');

    await expect(page.locator('#near-deposit-address')).toHaveText(NEAR_DEPOSIT_ADDRESS);
    await expect(page.locator('.near-swap-instruction')).toContainText('Send exactly 2.68 USDC on Ethereum');
    await expect(page.locator('.near-intents-warning')).toContainText(REFUND);
    expect(quoteBodies).toHaveLength(quotesBeforeConfirm + 1);
    expect(quoteBodies.at(-1)).toMatchObject({ dry: false, recipient: depositAddress, refundTo: REFUND, refundType: 'ORIGIN_CHAIN' });

    // Status polling follows the swap to delivery.
    await expect(page.locator('#near-swap-status')).toContainText('DASH delivered', { timeout: 20_000 });

    // The bridge's own deposit flow is untouched and carries on.
    await page.evaluate(() => (window as { __e2eMockAdvance?: () => void }).__e2eMockAdvance?.());
    await expect(page.getByText('Save your keys')).toBeVisible();
  });

  test('prices either side, enforces the deposit minimum and switches assets from the picker', async ({ page }) => {
    const quoteBodies = await stubOneClick(page, 'ok');
    await openDepositScreen(page);
    await page.click('#deposit-tab-near');
    await expect(page.locator('#near-amount-in')).toHaveValue('2.68');

    // Typing what to pay asks for an EXACT_INPUT quote.
    await page.fill('#near-amount-in', '20');
    await expect(page.locator('#near-amount-out')).toHaveValue('0.394008');
    await expect(page.locator('.near-amount-note')).toContainText('At least 0.390068 DASH');
    expect(quoteBodies.at(-1)).toMatchObject({ dry: true, swapType: 'EXACT_INPUT', amount: '20000000' });

    // Too little DASH is caught before asking 1Click, with a one-click fix.
    const quotes = quoteBodies.length;
    await page.fill('#near-amount-out', '0.001');
    await expect(page.locator('.near-intents-error')).toContainText('needs at least 0.003 DASH');
    expect(quoteBodies).toHaveLength(quotes);
    await page.click('#near-use-min-btn');
    await expect(page.locator('#near-amount-out')).toHaveValue('0.003');
    await expect(page.locator('#near-amount-in')).toHaveValue('2.68');
    expect(quoteBodies.at(-1)).toMatchObject({ swapType: 'EXACT_OUTPUT', amount: '300000' });

    // The picker searches by symbol or chain; DASH itself is not offered.
    await page.click('#near-asset-btn');
    await expect(page.locator('#near-asset-filter')).toBeFocused();
    await expect(page.locator('.near-token-option[data-asset-id="nep141:dash.omft.near"]')).toHaveCount(0);
    await page.fill('#near-asset-filter', 'solana');
    await page.locator('.near-token-option', { hasText: 'SOL' }).click();
    await expect(page.locator('#near-asset-btn')).toContainText('SOL');
    await expect(page.locator('label[for="near-refund-input"]')).toHaveText('Refund address on Solana');
    await expect.poll(() => quoteBodies.at(-1)?.originAsset).toBe('nep141:sol.omft.near');

    // Pricing paused by the picker picks up again when it closes.
    await page.fill('#near-amount-out', '0.1');
    await page.click('#near-asset-btn');
    await page.keyboard.press('Escape');
    // The stub prices 2680000 smallest units: 0.00268 SOL at 9 decimals.
    await expect(page.locator('#near-amount-in')).toHaveValue('0.00268');
    expect(quoteBodies.at(-1)).toMatchObject({ swapType: 'EXACT_OUTPUT', amount: '10000000' });
  });

  test('explains when NEAR Intents has no liquidity into DASH, and the DASH deposit stays usable', async ({ page }) => {
    await stubOneClick(page, 'no-liquidity');
    await openDepositScreen(page);

    await page.click('#deposit-tab-near');
    await expect(page.locator('.near-intents-error')).toContainText("NEAR Intents can't route this asset to DASH right now");
    await expect(page.locator('#near-confirm-btn')).toBeDisabled();
    const fallback = page.locator('.near-intents-fallback a');
    await expect(fallback).toHaveAttribute('href', 'https://near-intents.org/?from=USDC:eth&to=DASH');

    // The regular DASH deposit is one tab away and unaffected.
    await page.click('#deposit-tab-dash');
    await expect(page.locator('.address-section .address')).toBeVisible();
    await page.evaluate(() => (window as { __e2eMockAdvance?: () => void }).__e2eMockAdvance?.());
    await expect(page.getByText('Save your keys')).toBeVisible();
  });

  test('is not offered on testnet', async ({ page }) => {
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
    await page.goto(MOCK_QUERY);
    await page.click('#mode-create-btn');
    await page.click('#continue-btn');
    await expect(page.locator('.deposit-headline')).toBeVisible();
    await expect(page.locator('#deposit-tab-near')).toHaveCount(0);
  });
});

test.describe('Mainnet DashPay app recommendation (mock mode)', () => {
  const MAINNET_QUERY = '/?network=mainnet&e2e=mock';
  const APP_STORE_URL = 'https://apps.apple.com/app/id1206647026';
  const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=hashengineering.darkcoin.wallet';
  const blockExternal = (page: import('@playwright/test').Page) =>
    page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());

  test.beforeEach(async ({ page }) => {
    await blockExternal(page);
  });

  test('identity creation is gated behind the app recommendation and an explicit acknowledgement', async ({ page }) => {
    await page.goto(MAINNET_QUERY);
    await expect(page.locator('#mobile-app-hint')).toContainText('DashPay mobile app');
    await expect(page.locator('meta[name="apple-itunes-app"]')).toHaveCount(1);
    await expect(page.locator('meta[name="apple-itunes-app"]')).toHaveAttribute('content', 'app-id=1206647026');

    await page.click('#mode-create-btn');
    await expect(page.getByRole('heading', { name: /Use the DashPay app/ })).toBeVisible();
    for (const [id, url] of [['#mobile-app-app-store-btn', APP_STORE_URL], ['#mobile-app-google-play-btn', GOOGLE_PLAY_URL]]) {
      await expect(page.locator(id)).toHaveAttribute('href', url);
      await expect(page.locator(id)).toHaveAttribute('target', '_blank');
      await expect(page.locator(id)).toHaveAttribute('rel', 'noopener noreferrer');
    }
    await expect(page.locator('.mobile-app-qr img')).toHaveCount(2);

    const continueBtn = page.locator('#mobile-app-continue-browser-btn');
    await expect(continueBtn).toBeDisabled();
    await page.locator('#mobile-app-ack-checkbox').check();
    await expect(continueBtn).toBeEnabled();

    await continueBtn.click();
    await expect(page.locator('#continue-btn')).toBeVisible();
    await expect(page.locator('.keys-reassurance')).toBeVisible();
  });

  test('Back returns to the landing screen and the gate shows again', async ({ page }) => {
    await page.goto(MAINNET_QUERY);
    await page.click('#mode-create-btn');
    await page.locator('#mobile-app-ack-checkbox').check();
    await page.click('#back-btn');
    await expect(page.locator('#mode-create-btn')).toBeVisible();

    await page.click('#mode-create-btn');
    await expect(page.locator('#mobile-app-continue-browser-btn')).toBeDisabled();
  });

  test('testnet goes straight to key configuration', async ({ page }) => {
    await page.goto(MOCK_QUERY);
    await expect(page.locator('#mobile-app-hint')).toHaveCount(0);
    await expect(page.locator('meta[name="apple-itunes-app"]')).toHaveCount(0);
    await page.click('#mode-create-btn');
    await expect(page.locator('#continue-btn')).toBeVisible();
  });

  test('on an iPhone the App Store button is the focused primary action', async ({ browser }) => {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await blockExternal(page);
    await page.goto(MAINNET_QUERY);

    await page.click('#mode-create-btn');
    const cta = page.locator('#mobile-app-primary-cta');
    await expect(cta).toHaveAttribute('href', APP_STORE_URL);
    await expect(cta).toBeFocused();
    await expect(page.locator('#mobile-app-google-play-btn')).toHaveCount(0);
    await context.close();
  });
});


test('rejects malformed Platform addresses before showing a deposit address', async ({ page }) => {
  await page.goto('/?network=testnet&e2e=mock');
  await page.click('#mode-send-to-address-btn');
  for (const bytes of [new Uint8Array([0xb0]), new Uint8Array(21).fill(0xff)]) {
    const address = bech32m.encode('tdash', bech32m.toWords(bytes));
    await page.fill('#recipient-address-input', address);
    await page.click('#continue-send-to-address-btn');
    await expect(page.locator('#recipient-address-validation-msg')).toBeVisible();
    await expect(page.locator('.deposit-headline')).toHaveCount(0);
  }
});

test('ignores malformed address deep links', async ({ page }) => {
  const address = bech32m.encode('tdash', bech32m.toWords(new Uint8Array([0xb0])));
  await page.goto(`/?network=testnet&e2e=mock&address=${address}`);
  await expect(page.locator('#mode-create-btn')).toBeVisible();
  await expect(page.locator('#recipient-address-input')).toHaveCount(0);
});

for (const type of [0xb0, 0x80]) {
  test(`accepts a valid Platform address of type ${type}`, async ({ page }) => {
    const bytes = new Uint8Array(21).fill(1);
    bytes[0] = type;
    const address = bech32m.encode('tdash', bech32m.toWords(bytes));
    await page.goto(`/?network=testnet&e2e=mock&address=${address}`);
    await expect(page.locator('#recipient-address-input')).toHaveValue(address);
    await page.click('#continue-send-to-address-btn');
    await expect(page.locator('.deposit-headline')).toBeVisible();
  });
}

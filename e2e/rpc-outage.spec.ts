import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { E2E_MOCK_IDENTITY_ID } from '../src/e2e-mock-constants';

// Run the real signing/orchestration code, but intercept every external request.
// These fixtures cannot fund, broadcast, or submit a real transaction.
for (const cancelAndResume of [false, true]) {
  test(`blocked RPC recovers the same asset lock${cancelAndResume ? ' after cancellation' : ''}`, async ({ page }) => {
    test.setTimeout(60000);
    let txid = '';
    let broadcasts = 0;
    let rpcRequests = 0;
    const json = (value: unknown) => ({ contentType: 'application/json', body: JSON.stringify(value) });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        if (url.pathname === '/src/platform/status.ts') {
          await route.fulfill({ contentType: 'application/javascript', body: `
            export async function fetchPlatformStatus() {
              return { coreChainLockedHeight: window.__testChainHeight ?? 99,
                latestBlockHeight: 10, latestBlockTimeMs: Date.now() };
            }
          ` });
        } else if (url.pathname === '/src/platform/index.ts') {
          await route.fulfill({ contentType: 'application/javascript', body: `
            export async function registerIdentity(proof) {
              (window.__testProofs ??= []).push(proof);
              return { identityId: '${E2E_MOCK_IDENTITY_ID}', balance: 1, revision: 0 };
            }
          ` });
        } else await route.continue();
        return;
      }
      if (url.hostname.endsWith('digitalcash.dev')) {
        rpcRequests++;
        await route.abort('blockedbyclient');
      } else if (url.hostname === 'insight.testnet.networks.dash.org') {
        if (url.pathname.endsWith('/utxo')) {
          await route.fulfill(json([{ txid: 'a'.repeat(64), vout: 0, satoshis: 300000,
            scriptPubKey: `76a914${'11'.repeat(20)}88ac`, confirmations: 1 }]));
        } else if (url.pathname.endsWith('/tx/send')) {
          broadcasts++;
          const raw = Buffer.from(route.request().postDataJSON().rawtx, 'hex');
          const hash = createHash('sha256').update(createHash('sha256').update(raw).digest()).digest();
          txid = hash.reverse().toString('hex');
          await route.fulfill(json({ txid }));
        } else if (url.pathname.includes('/tx/')) {
          await route.fulfill(json({ txid, blockheight: 100, confirmations: 1 }));
        } else await route.fulfill(json({ info: { blocks: 100 } }));
      } else await route.abort();
    });
    await page.goto('/?network=testnet');
    await page.click('#mode-create-btn');
    await page.click('#continue-btn');
    await expect(page.getByRole('heading', { name: 'Waiting for chain lock', exact: true })).toBeVisible({ timeout: 40000 });
    expect(broadcasts).toBe(1);
    expect(rpcRequests).toBe(3);
    expect(await page.evaluate(() => (window as any).__testProofs)).toBeUndefined();
    if (cancelAndResume) {
      await page.click('#chainlock-cancel-btn');
      await expect(page.locator('.error-code-badge')).toHaveText('ERR-1014');
      await page.click('#chainlock-fallback-btn');
    }
    await page.evaluate(() => { (window as any).__testChainHeight = 100; });
    await expect(page.getByText('Save your keys', { exact: true })).toBeVisible({ timeout: 15000 });
    const proofs = await page.evaluate(() => (window as any).__testProofs);
    expect(proofs).toEqual([{ type: 'chain', txid, vout: 0, coreChainLockedHeight: 100 }]);
    expect(broadcasts).toBe(1);
  });
}

import { createHash } from 'node:crypto';
import { bech32m } from '@scure/base';
import { expect, test } from '@playwright/test';
import { E2E_MOCK_IDENTITY_ID } from '../src/e2e-mock-constants';

// Exercise real signing/orchestration, intercepting every external request.
// No fixture can fund, broadcast, or submit a real transaction.
for (const network of ['mainnet', 'testnet']) {
  for (const flow of ['create', 'topup', 'send', 'recheck', 'cancel'] as const) {
    test(`${network} ${flow} works without Digital Cash RPC`, async ({ page }) => {
      test.setTimeout(60000);
      let txid = '';
      let broadcasts = 0;
      let rpcRequests = 0;
      let depositReady = flow !== 'recheck';
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
              const record = (operation, proof) => (window.__testProofs ??= []).push({ operation, proof });
              export async function registerIdentity(proof) {
                record('create', proof);
                return { identityId: '${E2E_MOCK_IDENTITY_ID}', balance: 1, revision: 0 };
              }
              export async function topUpIdentity(id, proof) { record('topup', proof); }
              export async function sendToPlatformAddress(address, proof) { record('send', proof); }
            ` });
          } else await route.continue();
          return;
        }
        if (url.hostname === 'digitalcash.dev' || url.hostname.endsWith('.digitalcash.dev')) {
          rpcRequests++;
          await route.abort('namenotresolved');
        } else if (['insight.testnet.networks.dash.org', 'insight.dash.org'].includes(url.hostname)) {
          if (url.pathname.endsWith('/utxo')) {
            await route.fulfill(json(depositReady ? [{ txid: 'a'.repeat(64), vout: 0, satoshis: 300000,
              scriptPubKey: `76a914${'11'.repeat(20)}88ac`, confirmations: 1 }] : []));
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
      if (flow === 'recheck') await page.clock.install();
      await page.goto(`/?network=${network}`);
      if (flow === 'topup') {
        await page.click('#mode-manage-btn');
        await page.click('#manage-action-topup-btn');
        await page.fill('#identity-id-input', E2E_MOCK_IDENTITY_ID);
        await page.click('#continue-topup-btn');
      } else if (flow === 'send') {
        await page.click('#mode-send-to-address-btn');
        const address = bech32m.encode(network === 'mainnet' ? 'dash' : 'tdash', bech32m.toWords(new Uint8Array(21).fill(1)));
        await page.fill('#recipient-address-input', address);
        await page.click('#continue-send-to-address-btn');
      } else {
        await page.click('#mode-create-btn');
        await page.click('#continue-btn');
      }
      if (flow === 'recheck') {
        await expect(page.locator('.deposit-headline')).toBeVisible();
        await page.clock.fastForward(125000);
        await expect(page.locator('#recheck-deposit-btn')).toBeVisible();
        depositReady = true;
        await page.click('#recheck-deposit-btn');
      }
      await expect(page.getByRole('heading', { name: 'Waiting for chain lock', exact: true })).toBeVisible({ timeout: 40000 });
      expect(broadcasts).toBe(1);
      expect(await page.evaluate(() => (window as any).__testProofs)).toBeUndefined();
      if (flow === 'cancel') {
        await page.click('#chainlock-cancel-btn');
        await expect(page.locator('.error-code-badge')).toHaveText('ERR-1014');
        await page.click('#chainlock-fallback-btn');
      }
      await page.evaluate(() => { (window as any).__testChainHeight = 100; });
      const completion = flow === 'topup' ? 'Top-up complete!' : flow === 'send' ? 'Send complete!' : 'Save your keys';
      await expect(page.getByText(completion, { exact: true })).toBeVisible({ timeout: 15000 });
      const proofs = await page.evaluate(() => (window as any).__testProofs);
      const operation = flow === 'send' || flow === 'topup' ? flow : 'create';
      expect(proofs).toEqual([{ operation, proof: { type: 'chain', txid, vout: 0, coreChainLockedHeight: 100 } }]);
      expect(broadcasts).toBe(1);
      expect(rpcRequests).toBe(0);
    });
  }
}

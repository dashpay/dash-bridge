import { expect, test, type Frame, type Page } from '@playwright/test';
import { E2E_MOCK_IDENTITY_ID } from '../src/e2e-mock-constants';

/** A third-party app on another origin, served by request interception. */
const HOST_ORIGIN = 'https://host.test';

type Msg = Record<string, unknown>;

/** Serve a host page at https://host.test/ that frames `src` and records bridge messages. */
async function openHostPage(page: Page, src: string): Promise<void> {
  const bridgeOrigin = new URL(src).origin;
  await page.route(`${HOST_ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><body>
        <h1>Host app</h1>
        <iframe id="bridge" src="${src}" width="480" height="760"
          sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-forms allow-modals"
          allow="clipboard-write"></iframe>
        <script>
          window.__msgs = [];
          window.addEventListener('message', (event) => {
            if (event.origin !== ${JSON.stringify(bridgeOrigin)}) return;
            if (event.source !== document.getElementById('bridge').contentWindow) return;
            window.__msgs.push(event.data);
          });
        </script>
      </body></html>`,
    }),
  );
  await page.goto(`${HOST_ORIGIN}/`);
}

async function bridgeFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector('#bridge');
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('bridge iframe has no frame');
  return frame;
}

async function advanceMockDeposit(target: Page | Frame): Promise<void> {
  await expect
    .poll(() => target.evaluate(() => typeof (window as { __e2eMockAdvance?: () => void }).__e2eMockAdvance))
    .toBe('function');
  await target.evaluate(() => (window as { __e2eMockAdvance?: () => void }).__e2eMockAdvance?.());
}

const hostMessages = (page: Page) => page.evaluate(() => (window as unknown as { __msgs: Msg[] }).__msgs);

test.describe('Embeddable identity widget', () => {
  test('iframe embed posts the protocol messages to the declared origin only', async ({ page, baseURL }) => {
    const src = `${baseURL}/?embed=iframe&origin=${encodeURIComponent(HOST_ORIGIN)}&network=testnet&e2e=mock&requestId=abc&app=Host%20App`;
    await openHostPage(page, src);
    const frame = await bridgeFrame(page);

    // Straight into create mode with the embed banner; no landing screen or footer.
    await expect(frame.locator('.embed-banner')).toContainText('Creating an identity for Host App');
    await expect(frame.locator('.embed-banner')).toContainText('(https://host.test)');
    await expect(frame.locator('#mode-create-btn')).toHaveCount(0);
    await expect(frame.locator('footer')).toHaveCount(0);

    await frame.click('#continue-btn');
    await expect(frame.locator('.deposit-headline')).toBeVisible();
    await advanceMockDeposit(frame);
    await expect(frame.getByText('Save your keys')).toBeVisible();
    await expect(frame.locator('#embed-return-btn')).toHaveText('Return to Host App');

    await expect.poll(async () => (await hostMessages(page)).some((m) => m.type === 'identity-created')).toBe(true);
    const msgs = await hostMessages(page);
    const envelope = { source: 'dash-bridge', version: 1, request: 'create-identity', requestId: 'abc' };

    expect(msgs[0]).toEqual({ ...envelope, type: 'ready' });
    expect(msgs.filter((m) => m.type === 'progress').map((m) => m.step)).toEqual([
      'configuring',
      'awaiting_deposit',
      'processing',
      'registering',
      'complete',
    ]);
    expect(msgs.find((m) => m.type === 'identity-created')).toEqual({
      ...envelope,
      type: 'identity-created',
      identityId: E2E_MOCK_IDENTITY_ID,
      network: 'testnet',
    });
    for (const msg of msgs) {
      expect(Object.keys(msg).every((k) => [...Object.keys(envelope), 'type', 'step', 'identityId', 'network'].includes(k))).toBe(true);
    }

    await frame.click('#embed-return-btn');
    await expect.poll(async () => (await hostMessages(page)).at(-1)).toEqual({ ...envelope, type: 'close' });
  });

  test('iframe embed refuses a host that does not match the declared origin', async ({ page, baseURL }) => {
    const src = `${baseURL}/?embed=iframe&origin=${encodeURIComponent('https://other.test')}&network=testnet&e2e=mock`;
    await openHostPage(page, src);
    const frame = await bridgeFrame(page);
    await expect(frame.getByText('Request refused')).toBeVisible();
    await expect(frame.locator('#continue-btn')).toHaveCount(0);
    expect(await hostMessages(page)).toEqual([]);
  });

  test('the bridge refuses to run framed without embed=iframe', async ({ page, baseURL }) => {
    await openHostPage(page, `${baseURL}/?network=testnet&e2e=mock`);
    const frame = await bridgeFrame(page);
    await expect(frame.getByText("This page can't run inside another site")).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Open Dash Bridge in a new window' })).toHaveAttribute('target', '_blank');
    await expect(frame.locator('#mode-create-btn')).toHaveCount(0);
  });

  test('an invalid origin is rejected before anything runs', async ({ page }) => {
    await page.goto('/?embed=popup&origin=http%3A%2F%2Fevil.example&network=testnet&e2e=mock');
    await expect(page.getByText('Invalid request')).toBeVisible();
    await expect(page.locator('#continue-btn')).toHaveCount(0);
  });

  test('SDK popup flow resolves with the identity on the demo page', async ({ page, context }) => {
    await page.goto('/widget-demo.html?e2e=mock');
    await expect(page.locator('#popup-btn')).toBeEnabled();

    const popupPromise = context.waitForEvent('page');
    await page.click('#popup-btn');
    const popup = await popupPromise;
    await popup.waitForLoadState();

    await expect(popup.locator('.embed-banner')).toContainText('Creating an identity for Widget Demo');
    await popup.click('#continue-btn');
    await advanceMockDeposit(popup);
    await expect(popup.getByText('Save your keys')).toBeVisible();

    await expect(page.locator('#result')).toHaveText(`${E2E_MOCK_IDENTITY_ID} (testnet)`);
    await expect(page.locator('#log')).toContainText('progress: awaiting_deposit');

    const closed = popup.waitForEvent('close');
    await popup.click('#embed-return-btn');
    await closed;
  });

  test('SDK popup cancel rejects with cancelled', async ({ page, context }) => {
    await page.goto('/widget-demo.html?e2e=mock');
    await expect(page.locator('#popup-btn')).toBeEnabled();
    const popupPromise = context.waitForEvent('page');
    await page.click('#popup-btn');
    const popup = await popupPromise;
    await popup.click('#embed-cancel-btn');
    await expect(page.locator('#result')).toContainText('cancelled');
  });

  test('SDK iframe flow resolves and removes the iframe on return', async ({ page }) => {
    await page.goto('/widget-demo.html?e2e=mock');
    await expect(page.locator('#iframe-btn')).toBeEnabled();
    await page.click('#iframe-btn');

    const frame = await (await page.waitForSelector('#iframe-container iframe')).contentFrame();
    if (!frame) throw new Error('no iframe');
    await frame.click('#continue-btn');
    await advanceMockDeposit(frame);
    await expect(page.locator('#result')).toHaveText(`${E2E_MOCK_IDENTITY_ID} (testnet)`);

    await frame.click('#embed-return-btn');
    await expect(page.locator('#iframe-container iframe')).toHaveCount(0);
  });
});

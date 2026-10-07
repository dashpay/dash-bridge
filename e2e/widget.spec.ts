import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  E2E_MOCK_IDENTITY_ID,
  E2E_MOCK_LOGIN_HIGH_WIF,
  E2E_MOCK_LOGIN_MASTER_WIF,
  E2E_MOCK_LOGIN_PUBLIC_KEYS,
  E2E_MOCK_XFER_RECIPIENT_ID,
} from '../src/e2e-mock-constants';
import { verifyLogin } from '../src/widget/verify';
import { parseLoginFragment, type LoginResult } from '../src/embed/login';

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

  test('reloading the popup expires the request instead of starting a new one', async ({ page, context }) => {
    await page.goto('/widget-demo.html?e2e=mock');
    await expect(page.locator('#popup-btn')).toBeEnabled();
    const popupPromise = context.waitForEvent('page');
    await page.click('#popup-btn');
    const popup = await popupPromise;
    await expect(popup.locator('#continue-btn')).toBeVisible();

    await popup.reload();
    await expect(popup.getByText('Request expired')).toBeVisible();
    await expect(popup.locator('#continue-btn')).toHaveCount(0);
    // The reload alone does not settle the request...
    await expect(page.locator('#result')).toHaveText('waiting…');
    // ...closing the popup does.
    await popup.close();
    await expect(page.locator('#result')).toContainText('cancelled');
  });

  test('SDK iframe cancel rejects and removes the iframe', async ({ page }) => {
    await page.goto('/widget-demo.html?e2e=mock');
    await expect(page.locator('#iframe-btn')).toBeEnabled();
    await page.click('#iframe-btn');
    const frame = await (await page.waitForSelector('#iframe-container iframe')).contentFrame();
    if (!frame) throw new Error('no iframe');
    await frame.click('#embed-cancel-btn');
    await expect(page.locator('#result')).toContainText('cancelled');
    await expect(page.locator('#iframe-container iframe')).toHaveCount(0);
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

test.describe('Sign in with Dash', () => {
  const NONCE = 'e2e_login_nonce_0123456789';
  const loginQuery = (kind: string, extra = '') =>
    `?embed=${kind}&origin=${encodeURIComponent(HOST_ORIGIN)}&request=login&nonce=${NONCE}` +
    `&network=testnet&e2e=mock&app=Host%20App&statement=Welcome%20back${extra}`;
  const verifyForHost = (result: unknown) =>
    verifyLogin(result, {
      expectedOrigin: HOST_ORIGIN,
      expectedNonce: NONCE,
      network: 'testnet',
      identityPublicKeys: E2E_MOCK_LOGIN_PUBLIC_KEYS,
      expectedStatement: 'Welcome back',
    });

  async function enterCredentials(target: Page | Frame, privateKeyWif: string, identityId = E2E_MOCK_IDENTITY_ID) {
    await target.fill('#login-identity-input', identityId);
    await target.fill('#login-wif-input', privateKeyWif);
    await target.click('#login-continue-btn');
  }

  /** Host page at https://host.test/ that opens `src` in a popup and records its messages. */
  async function openPopupFromHost(page: Page, src: string): Promise<Page> {
    const bridgeOrigin = new URL(src).origin;
    await page.route(`${HOST_ORIGIN}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!DOCTYPE html><html><body>
          <button id="open">Sign in</button>
          <script>
            window.__msgs = [];
            let popup = null;
            document.getElementById('open').onclick = () => {
              popup = window.open(${JSON.stringify(src)}, 'bridge', 'popup=yes,width=480,height=760');
            };
            window.addEventListener('message', (event) => {
              if (event.origin !== ${JSON.stringify(bridgeOrigin)} || event.source !== popup) return;
              window.__msgs.push(event.data);
            });
          </script>
        </body></html>`,
      }),
    );
    await page.goto(`${HOST_ORIGIN}/`);
    const popupPromise = page.context().waitForEvent('page');
    await page.click('#open');
    const popup = await popupPromise;
    await popup.waitForLoadState();
    return popup;
  }

  test('popup login posts a login message that verifies for the host origin', async ({ page, baseURL }) => {
    const popup = await openPopupFromHost(page, `${baseURL}/${loginQuery('popup', '&requestId=lg1')}`);
    await expect(popup.locator('.embed-banner')).toContainText('Sign in to Host App');
    await expect(popup.locator('#login-wif-input')).toHaveAttribute('type', 'password');
    await enterCredentials(popup, E2E_MOCK_LOGIN_HIGH_WIF);

    await expect(popup.locator('#login-review-key')).toHaveText('Key #1 · AUTHENTICATION · HIGH · ECDSA_SECP256K1');
    await expect(popup.locator('#login-review-identity')).toHaveText(E2E_MOCK_IDENTITY_ID);
    await expect(popup.getByText('Welcome back')).toBeVisible();
    await expect(popup.locator('.login-note')).toContainText('Signing proves to host.test');
    const closed = popup.waitForEvent('close');
    await popup.click('#login-sign-btn');
    await closed;

    await expect.poll(async () => (await hostMessages(page)).some((m) => m.type === 'login')).toBe(true);
    const msgs = await hostMessages(page);
    expect(msgs.map((m) => m.type)).toEqual(['ready', 'login']);
    const login = msgs[1];
    expect(Object.keys(login).sort()).toEqual(
      ['source', 'version', 'type', 'request', 'requestId', 'identityId', 'keyId', 'network', 'message', 'signature', 'nonce', 'issuedAt', 'expiresAt'].sort(),
    );
    expect(login).toMatchObject({ source: 'dash-bridge', version: 1, request: 'login', requestId: 'lg1', identityId: E2E_MOCK_IDENTITY_ID, keyId: 1 });
    expect(JSON.stringify(msgs)).not.toContain(E2E_MOCK_LOGIN_HIGH_WIF);
    expect(verifyForHost(login)).toEqual({ ok: true, identityId: E2E_MOCK_IDENTITY_ID, keyId: 1 });
    // Bound to the host origin: useless to any other site.
    const forOtherSite = { expectedOrigin: 'https://evil.test', expectedNonce: NONCE, network: 'testnet', identityPublicKeys: E2E_MOCK_LOGIN_PUBLIC_KEYS };
    expect(verifyLogin(login, forOtherSite)).toEqual({ ok: false, reason: 'origin_mismatch' });
  });

  test('refuses the MASTER key and unknown identities', async ({ page, baseURL }) => {
    const popup = await openPopupFromHost(page, `${baseURL}/${loginQuery('popup')}`);

    await enterCredentials(popup, E2E_MOCK_LOGIN_MASTER_WIF);
    await expect(popup.locator('#login-error')).toContainText('never paste your MASTER key');
    await expect(popup.locator('#login-sign-btn')).toHaveCount(0);

    await enterCredentials(popup, E2E_MOCK_LOGIN_HIGH_WIF, E2E_MOCK_XFER_RECIPIENT_ID);
    await expect(popup.locator('#login-error')).toContainText('Identity not found on testnet');
    expect((await hostMessages(page)).map((m) => m.type)).toEqual(['ready']);
  });

  test('refuses to sign in inside an iframe and tells the host', async ({ page, baseURL }) => {
    await openHostPage(page, `${baseURL}/${loginQuery('iframe', '&requestId=lg2')}`);
    const frame = await bridgeFrame(page);
    await expect(frame.getByText('Unsupported request')).toBeVisible();
    await expect(frame.locator('#login-wif-input')).toHaveCount(0);
    await expect.poll(() => hostMessages(page)).toEqual([
      expect.objectContaining({ type: 'error', request: 'login', requestId: 'lg2', code: 'unsupported_mode', fatal: true }),
    ]);
  });

  test('SDK popup login resolves and verifies on the demo page', async ({ page, context }) => {
    await page.goto('/widget-demo.html?e2e=mock');
    await expect(page.locator('#login-popup-btn')).toBeEnabled();
    const popupPromise = context.waitForEvent('page');
    await page.click('#login-popup-btn');
    const popup = await popupPromise;
    await popup.waitForLoadState();

    await expect(popup.locator('.embed-banner')).toContainText('Sign in to Widget Demo');
    await enterCredentials(popup, E2E_MOCK_LOGIN_HIGH_WIF);
    const closed = popup.waitForEvent('close');
    await popup.click('#login-sign-btn');
    await closed;

    await expect(page.locator('#login-result')).toHaveText(`${E2E_MOCK_IDENTITY_ID} (key #1, testnet)`);
    await expect(page.locator('#login-verify')).toHaveText(`verified: ${E2E_MOCK_IDENTITY_ID} key #1`);
  });

  test('SDK redirect login round-trips through the bridge on the demo page', async ({ page }) => {
    await page.goto('/widget-demo.html?e2e=mock');
    await expect(page.locator('#login-redirect-btn')).toBeEnabled();
    await page.click('#login-redirect-btn');
    await expect(page.locator('.embed-banner')).toContainText('Sign in to Widget Demo');
    await enterCredentials(page, E2E_MOCK_LOGIN_HIGH_WIF);
    await page.click('#login-sign-btn');

    await expect(page.locator('#login-verify')).toHaveText(`verified: ${E2E_MOCK_IDENTITY_ID} key #1`);
    // The demo clears the fragment as soon as it has read it.
    expect(new URL(page.url()).hash).toBe('');
  });

  test.describe('redirect mode', () => {
    const RETURN_URL = `${HOST_ORIGIN}/auth/callback`;
    const FROM_HOST = { referer: `${HOST_ORIGIN}/login` };
    const redirectQuery = (returnUrl = RETURN_URL) => loginQuery('redirect', `&returnUrl=${encodeURIComponent(returnUrl)}`);

    test.beforeEach(async ({ page }) => {
      await page.route(`${HOST_ORIGIN}/**`, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><h1>Host callback</h1>' }),
      );
    });

    test('lands on returnUrl with #dash_login= holding a verifiable result', async ({ page, baseURL }) => {
      await page.goto(`${baseURL}/${redirectQuery()}`, FROM_HOST);
      await expect(page.locator('.embed-banner')).toContainText('Sign in to Host App');
      await enterCredentials(page, E2E_MOCK_LOGIN_HIGH_WIF);
      await page.click('#login-sign-btn');

      await page.waitForURL(/^https:\/\/host\.test\/auth\/callback#dash_login=/);
      const url = new URL(page.url());
      expect(url.hash).not.toContain(E2E_MOCK_LOGIN_HIGH_WIF);
      const result = parseLoginFragment(url.hash) as LoginResult;
      expect(verifyForHost(result)).toEqual({ ok: true, identityId: E2E_MOCK_IDENTITY_ID, keyId: 1 });
    });

    test('cancel lands on returnUrl with #dash_login_error=cancelled', async ({ page, baseURL }) => {
      await page.goto(`${baseURL}/${redirectQuery()}`, FROM_HOST);
      await page.click('#login-cancel-btn');
      await page.waitForURL(`${RETURN_URL}#dash_login_error=cancelled`);
    });

    test('refuses a request that the app did not send (no or foreign referrer)', async ({ page, baseURL }) => {
      for (const options of [{}, { referer: 'https://evil.test/phish' }]) {
        await page.goto(`${baseURL}/${redirectQuery()}`, options);
        await expect(page.getByText('Request refused')).toBeVisible();
        await expect(page.locator('#login-identity-input')).toHaveCount(0);
        expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
      }
    });

    test('refuses a returnUrl on another origin or with a query string', async ({ page, baseURL }) => {
      for (const returnUrl of ['https://evil.test/cb', `${HOST_ORIGIN}/out?to=https://evil.test`]) {
        await page.goto(`${baseURL}/${redirectQuery(returnUrl)}`, FROM_HOST);
        await expect(page.getByText('Invalid request')).toBeVisible();
        await expect(page.locator('#login-identity-input')).toHaveCount(0);
      }
    });
  });
});

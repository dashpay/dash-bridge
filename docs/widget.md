# Embeddable identity widget

Third-party web apps (for example Dash Platform dapps) can add a **Create Dash
identity** button. The button opens the Dash Bridge, the user creates an
identity there, and the app receives the new **identity ID**.

Apps can also add a **Sign in with Dash** button. The user proves in the bridge
that they control an existing identity, and the app's server verifies the
proof. See [Sign in with Dash](#sign-in-with-dash).

The bridge stays non-custodial. The mnemonic, private keys and key backup never
leave the bridge window. The user downloads their key backup inside the bridge,
exactly as in the standalone flow. The app receives only the fields listed in
[Message protocol](#message-protocol).

- SDK: `https://bridge.thepasta.org/widget.js` (classic script, global
  `DashBridge`) or `https://bridge.thepasta.org/widget.mjs` (ES module). It has
  no dependencies and is about 9 KB.
- Live demo: <https://bridge.thepasta.org/widget-demo.html>

These URLs are not versioned. They always serve the latest SDK, so you can't
pin them with Subresource Integrity (`integrity="..."`). If you need SRI, host
a copy of `widget.js` yourself and update it when you choose. The message
protocol is versioned (`version: 1`), so an older SDK keeps working with a
newer bridge until the protocol version changes.

## Quick start

### Script tag

```html
<button id="create-identity">Create Dash identity</button>
<script src="https://bridge.thepasta.org/widget.js"></script>
<script>
  document.getElementById('create-identity').addEventListener('click', async () => {
    try {
      // Call createIdentity synchronously inside the click handler so the
      // browser lets the popup open.
      const { identityId, network } = await DashBridge.createIdentity({
        network: 'testnet',
        appName: 'My Dapp',
        onProgress: (step) => console.log('bridge step:', step),
      });
      console.log('New identity', identityId, 'on', network);
    } catch (err) {
      if (err.code === 'cancelled') return; // user closed the bridge
      if (err.code === 'popup_blocked') alert('Please allow popups for this site');
      else console.error(err);
    }
  });
</script>
```

### ES module

```js
import { createIdentity } from 'https://bridge.thepasta.org/widget.mjs';

button.addEventListener('click', () => {
  createIdentity({ network: 'mainnet', appName: 'My Dapp' })
    .then(({ identityId }) => saveIdentity(identityId))
    .catch((err) => console.warn(err.code, err.message));
});
```

### iframe mode

```js
DashBridge.createIdentity({
  mode: 'iframe',
  container: document.getElementById('bridge-slot'),
  network: 'testnet',
});
```

The SDK adds the iframe to `container`. After the identity is created, the
promise resolves but the iframe stays mounted so the user can save their keys.
The SDK removes it, and stops listening, when the user clicks **Return to
<app>**, when the user cancels, or when you abort the request. If you remove
the iframe yourself, the SDK notices and cleans up. Before a result, that
counts as `cancelled`.

## API

```ts
DashBridge.createIdentity(options?: {
  network?: 'mainnet' | 'testnet';    // default 'testnet'
  mode?: 'popup' | 'iframe';          // default 'popup' (recommended)
  container?: HTMLElement;            // required in iframe mode
  appName?: string;                   // shown to the user, max 64 chars
  bridgeUrl?: string;                 // default 'https://bridge.thepasta.org/'
  onProgress?: (step: ProgressStep) => void;
  onError?: (error: { code: string; message: string }) => void; // recoverable errors
  signal?: AbortSignal;               // abort: closes the popup / removes the iframe
}): Promise<{ identityId: string; network: string }>;
```

`ProgressStep` is one of `configuring`, `awaiting_deposit`, `processing`,
`registering`, `complete` or `error`.

The promise rejects with a `DashBridge.DashBridgeError`. Its `code` is one of:

| `code` | Meaning |
| --- | --- |
| `popup_blocked` | `window.open` was blocked. Call `createIdentity` directly from a click handler. |
| `cancelled` | The user pressed Cancel, closed the popup, or the iframe was removed. |
| `aborted` | Your `AbortSignal` fired. |
| `invalid_options` | Bad arguments. Also returned when your page or `bridgeUrl` is not https. Plain http is allowed only on `localhost`, `127.0.0.1` and `[::1]`, the same rule the bridge applies. |
| `bridge_unavailable` | iframe mode: the bridge sent no `ready` within 30 seconds. Either it didn't load, or it refused the request and shows the reason inside the iframe. |
| `unsupported_network`, `unsupported_request` | Fatal error reported by the bridge. |

Recoverable errors, such as a failed InstantSend lock, are not rejections. The
user can retry or recover inside the bridge, so the promise keeps waiting. They
are passed to `onError`, and `onProgress` receives `error`.

Popup mode: once the identity is created, the promise resolves and the popup
stays open so the user can download their key backup. **Return to <app>**
closes it. After the promise settles, the SDK has no listeners or timers left
in popup mode.

A request lives in one page load. If the user reloads the popup or navigates
back to it, the bridge shows **Request expired** instead of starting a new
identity. The promise rejects with `cancelled` when the popup is closed.

## Popup or iframe?

**Use popup mode.** The user sees the bridge's own address bar, so they can
check where they are typing. File downloads (the key backup) and clipboard
access also work without extra permissions.

iframe mode is available for apps that need an inline flow. The SDK creates the
iframe with these attributes. If you create the iframe yourself, use the same
attributes:

```html
<iframe
  src="https://bridge.thepasta.org/?embed=iframe&origin=https%3A%2F%2Fyour.app&network=testnet&requestId=..."
  allow="clipboard-write"
  sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals"
  referrerpolicy="origin"
  style="width:100%;height:760px;border:0"></iframe>
```

- `allow-downloads`: the key backup download.
- `allow-popups` and `allow-popups-to-escape-sandbox`: explorer links.
- `allow-modals`: the "cancel after deposit?" confirmation.
- `clipboard-write`: the copy buttons.
- `referrerpolicy="origin"`: lets browsers without `location.ancestorOrigins`
  (Firefox) check who is framing the bridge.

Popup mode needs `window.opener`. If your app sends
`Cross-Origin-Opener-Policy: same-origin`, the browser cuts that link and the
bridge cannot report back. Use `same-origin-allow-popups` instead.

## Bridge URL parameters

The SDK builds these parameters for you. They are listed here for integrators
who open the bridge themselves.

| Parameter | Required | Description |
| --- | --- | --- |
| `embed` | yes | `popup` or `iframe`. |
| `origin` | yes | Your app's origin, bare: `https://app.example` (no path or trailing slash). `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`. |
| `network` | no | `mainnet` or `testnet` (default `testnet`). |
| `request` | no | `create-identity` (default) or `login` (see [Sign in with Dash](#sign-in-with-dash)). |
| `requestId` | no | Opaque ID, up to 64 characters from `[A-Za-z0-9_-]`. It is echoed in every message. |
| `app` | no | Display name. Control and formatting characters (including bidi overrides) are removed, and it is cut to 64 characters. |

In embed mode the bridge skips the landing screen and goes straight to identity
creation. It hides the network selector, the other modes and the footer. A
banner shows **Creating an identity for <app> (<origin>)**, with a Cancel
button. Cancel is hidden once identity registration starts. After a cancel in
iframe mode, the bridge replaces the flow with a **Request cancelled** notice,
in case the host doesn't remove the iframe.

## Message protocol

The bridge sends messages with `postMessage` to `window.opener` (popup) or
`window.parent` (iframe). The target origin is always the declared `origin`,
never `'*'`. Every message has this envelope:

```ts
{
  source: 'dash-bridge',
  version: 1,
  type: string,
  request: 'create-identity',  // echoes the request type
  requestId?: string,          // echoed if provided
}
```

| `type` | Extra fields | When |
| --- | --- | --- |
| `ready` | none | The bridge loaded and accepted the request. |
| `progress` | `step: ProgressStep` | The coarse step changed. |
| `identity-created` | `identityId: string`, `network: string` | The identity is registered on Platform. This is the result. |
| `login` | `identityId`, `keyId`, `network`, `message`, `signature`, `nonce`, `issuedAt`, `expiresAt` | `request: 'login'` result. See [Sign in with Dash](#sign-in-with-dash). |
| `error` | `code: string`, `message: string`, `fatal: boolean` | `fatal: true` means the request cannot continue. Otherwise the user can still recover in the bridge. `message` is a fixed label, not raw error text. |
| `cancelled` | none | The user cancelled. In iframe mode it is also sent, best effort, when the frame unloads before a result (`pagehide`). Popups don't send it on unload, because a reload would cancel a request the user is still working on. The SDK detects closed popups by polling `popup.closed`. |
| `close` | none | iframe mode: the user clicked **Return to <app>**. Remove the iframe. |

No other fields are ever sent. Each message is built from a per-type whitelist
(`src/embed/protocol.ts`), and a unit test checks that secrets passed in by
mistake are dropped.

If you handle messages yourself instead of using the SDK, accept a message only
if all of these hold:

1. `event.origin` is the bridge origin (`https://bridge.thepasta.org`).
2. `event.source` is the popup or iframe window you opened.
3. `data.source === 'dash-bridge'` and `data.version === 1`.
4. `data.requestId` is the random ID you generated for this request.

The bridge ignores all incoming messages. Apps cannot drive or query it.

Every request type uses the same envelope, URL parameters and lifecycle
messages. Each adds its own `request` value and result message.

## Security model

- **Keys stay in the bridge.** The mnemonic, WIFs and the key backup are never
  posted. The user downloads the backup inside the bridge before returning.
- **Origin-bound delivery.** Results are posted only to the declared origin, so
  a page that lies about its origin receives nothing. The banner shows the
  origin next to the app name, because the app name is self-declared and the
  origin is what receives the identity ID.
- **Clickjacking guard.** If the bridge is framed without `embed=iframe`, it
  shows "This page can't run inside another site" with a link that opens it in
  a new window. With `embed=iframe`, it checks the framing page's origin
  against the declared origin, using `location.ancestorOrigins[0]` or the
  referrer as a fallback. It refuses on a mismatch, and also when neither is
  available (for example `referrerpolicy="no-referrer"` in Firefox), because
  the banner would otherwise vouch for an origin nobody checked. A frame that
  claims `embed=popup` is also refused. The "open in a new window" link is
  rebuilt from scratch, keeping only `network`, so a framer can't pass
  deep-link parameters through it.
- **Strict parameters.** Invalid origins (non-https, paths, credentials),
  request IDs or request types stop the bridge before it runs. The app name is
  shown inside `<bdi>` after bidi and formatting characters are removed, so it
  can't visually reorder the origin next to it. Unsupported
  networks or request types are reported to the app as fatal errors.
- **SDK checks.** The SDK checks the origin, source window, envelope, version
  and `requestId` of every message. It uses a fresh random `requestId` (from
  `crypto.getRandomValues`) for each request. When a request ends it removes
  its listeners and timers. After a successful iframe request, the cleanup
  waits until the iframe goes away.
- **Cancelling after a deposit.** Once a deposit address exists, Cancel asks
  for confirmation. The key backup is needed to recover funds that were already
  sent. Cancel is not offered once the identity is being registered.
- **One request per page load.** A reload, back/forward navigation or
  back/forward-cache restore of an embed request shows **Request expired**. It
  never starts a new identity under the old request.

## Sign in with Dash

A "Dash Connect"-style login. The user signs a short, human-readable message
in the bridge with one of their identity's **AUTHENTICATION** keys (security
level **HIGH** or **CRITICAL**). Your server checks the signature against the
identity's public keys on Platform. The bridge never sees your app's session,
and your app never sees the user's private key.

```
 Your server            Your page (SDK)                Dash Bridge (popup / iframe / redirect)
 -----------            ---------------                ---------------------------------------
 1. issue nonce  ---->  2. DashBridge.login({ nonce })  ---->  3. user enters identity ID + WIF
                                                               4. bridge fetches the identity's keys
                                                                  from Platform, checks the key
                                                               5. user reviews app, identity, key
                                                                  and clicks "Sign in"
                                                               6. message signed locally; WIF dropped
                        7. resolves with the result    <----  (postMessage to your origin only,
                                                               or returnUrl#dash_login=...)
 8. verifyLogin(result, { expectedOrigin, expectedNonce,
      network, identityPublicKeys })  <-- keys fetched by YOUR server from Platform
 9. mark the nonce used, start a session for identityId
```

### Browser side

```js
// 1. Ask your server for a fresh nonce (it stores it, e.g. in the session).
const { nonce } = await fetch('/auth/dash/nonce', { method: 'POST' }).then((r) => r.json());

// 2. Must run inside the click handler for the popup; fetch the nonce
//    beforehand (e.g. on page load) so nothing is awaited first.
button.addEventListener('click', async () => {
  try {
    const result = await DashBridge.login({
      nonce,
      network: 'mainnet',
      appName: 'My Dapp',
      statement: 'Sign in to My Dapp', // optional, max 140 characters, shown and signed
    });
    // 3. Send the result to your server; do not trust it in the browser.
    await fetch('/auth/dash/verify', { method: 'POST', body: JSON.stringify(result) });
  } catch (err) {
    if (err.code !== 'cancelled') console.error(err);
  }
});
```

```ts
DashBridge.login(options: {
  nonce: string;                      // required, 16-128 chars of [A-Za-z0-9_-], from your server
  network?: 'mainnet' | 'testnet';    // default 'testnet'
  mode?: 'popup' | 'iframe';          // default 'popup'
  container?: HTMLElement;            // iframe mode
  appName?: string;
  statement?: string;                 // control characters removed, cut to 140 characters
  bridgeUrl?: string;
  signal?: AbortSignal;
}): Promise<LoginResult>;

interface LoginResult {
  identityId: string;
  keyId: number;        // the identity key that signed
  network: string;
  message: string;      // the exact signed text
  signature: string;    // base64, Dash signed-message format
  nonce: string;
  issuedAt: string;     // e.g. 2026-10-07T12:00:00Z
  expiresAt: string;    // issuedAt + 10 minutes
}

DashBridge.generateNonce(): string;   // 32 random bytes, base64url
```

`login()` rejects with the same error codes as `createIdentity()`. After the
result, the SDK closes the popup or removes the iframe; there is nothing left
to do in the bridge. `generateNonce()` is a convenience for demos and for
servers that run JavaScript. The nonce must come from your server and be
checked there, or a captured result can be replayed.

### Redirect variant

For full-page flows (no popup, no iframe), send the user to the bridge and
read the result when they come back:

```js
// Login page
location.assign(DashBridge.loginRedirectUrl({
  nonce,                          // from your server
  returnUrl: '/auth/dash/callback', // must be on this page's origin
  network: 'mainnet',
  appName: 'My Dapp',
}));

// /auth/dash/callback
const outcome = DashBridge.parseLoginRedirect(); // reads location.hash
history.replaceState(null, '', location.pathname + location.search); // drop the fragment
if (outcome && 'error' in outcome) {
  // 'cancelled', or 'invalid_response'
} else if (outcome) {
  await fetch('/auth/dash/verify', { method: 'POST', body: JSON.stringify(outcome) });
}
```

The bridge goes back with `location.replace` to
`returnUrl#dash_login=<base64url(JSON result)>`, or
`returnUrl#dash_login_error=cancelled` when the user cancels. The result is in
the fragment, so browsers never send it to any server, including yours: post
it from the page as above. Redirect mode refuses to run inside a frame.

Bridge URL parameters for a login, on top of the ones in
[Bridge URL parameters](#bridge-url-parameters):

| Parameter | Required | Description |
| --- | --- | --- |
| `request` | yes | `login` |
| `nonce` | yes | 16-128 characters of `[A-Za-z0-9_-]`. |
| `statement` | no | Short text shown to the user and signed. Control and formatting characters become spaces, then it is cut to 140 characters. |
| `embed` | yes | `popup`, `iframe`, or `redirect`. |
| `returnUrl` | redirect only | Absolute URL with exactly the `origin` parameter's origin, no credentials, at most 2048 characters. |

### The signed message

The bridge builds the message with one shared function
(`buildLoginMessage` in `src/embed/login.ts`), and the verifier rebuilds it the
same way and compares the bytes. Lines end with `\n`, with no trailing newline:

```
app.example wants you to sign in with your Dash Platform identity:
4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA

Sign in to My Dapp

URI: https://app.example
Network: mainnet
Key ID: 1
Nonce: 9f2bX_kd81LmQ0aZ7tYw3s
Issued At: 2026-10-07T12:00:00Z
Expiration Time: 2026-10-07T12:10:00Z
```

- The first line uses the host (with the port, if any) of your origin.
- The statement line and the empty line after it appear only if a statement was
  given.
- Times are ISO-8601 UTC with whole seconds. The proof expires 10 minutes after
  `Issued At`.

The signature is a standard Dash signed message, the same format as
`dash-cli signmessage` / `verifymessage` and dashcore-lib's `Message`:
`SHA256(SHA256(varstr("DarkCoin Signed Message:\n") || varstr(message)))`,
signed with secp256k1, encoded as a 65-byte recoverable compact signature
(header byte 31-34, compressed key) in base64.

### Server-side verification

`https://bridge.thepasta.org/widget-verify.mjs` is a self-contained ES module
(about 25 KB, no dependencies) for Node 18+ and browsers. Copy it into your
server project. Fetch the identity's public keys from Platform with
`@dashevo/evo-sdk` on your server, never from the client:

```js
import { EvoSDK } from '@dashevo/evo-sdk';
import { verifyLogin } from './widget-verify.mjs';

const sdk = EvoSDK.mainnetTrusted();
await sdk.connect();

app.post('/auth/dash/verify', async (req, res) => {
  const result = req.body;
  // Look up the nonce you issued to this browser session.
  const nonce = req.session.dashNonce;
  delete req.session.dashNonce; // single use, whatever the outcome
  if (!nonce) return res.status(400).send('no login in progress');

  const identity = await sdk.identities.fetch(result.identityId);
  if (!identity) return res.status(401).send('unknown identity');

  const verdict = verifyLogin(result, {
    expectedOrigin: 'https://app.example', // your origin, hard-coded
    expectedNonce: nonce,
    network: 'mainnet',
    identityPublicKeys: identity.toJSON().publicKeys,
  });
  if (!verdict.ok) return res.status(401).send(verdict.reason);

  req.session.identityId = verdict.identityId; // signed in
  res.sendStatus(204);
});
```

`verifyLogin(result, options)` returns `{ ok: true, identityId, keyId }` or
`{ ok: false, reason }`. Options:

| Option | Description |
| --- | --- |
| `expectedOrigin` | Your app's origin. The message's `URI:` line must match. |
| `expectedNonce` | The nonce you issued for this attempt. |
| `network` | `'mainnet'` or `'testnet'`: where you fetched the identity. |
| `identityPublicKeys` | The identity's keys. Accepts `identity.toJSON().publicKeys` (base64 data), `identity.publicKeys` or `sdk.identities.getKeys(...)` objects (`keyId`, `keyType`, string enums, hex data), `toObject()` output, or plain `{ id, type, purpose, securityLevel, data, disabledAt? }` objects with `data` as `Uint8Array`, `number[]`, hex or base64. |
| `expectedStatement` | Optional. Require exactly this statement. |
| `now` | Optional `Date` or milliseconds, for tests. |

It checks, in order:

1. The result has the expected shape (`malformed`).
2. The nonce, network and origin match (`nonce_mismatch`, `network_mismatch`,
   `origin_mismatch`), and the statement if you pinned one
   (`statement_mismatch`).
3. Rebuilding the message from the fields gives exactly `result.message`
   (`message_mismatch`).
4. `issuedAt` is at most 60 seconds in the future (`not_yet_valid`), it is
   before `expiresAt` (`expired`), and the window is at most 10 minutes
   (`malformed`).
5. Key `keyId` exists (`key_not_found`), is not disabled (`key_disabled`), has
   AUTHENTICATION purpose (`wrong_key_purpose`), and is CRITICAL or HIGH
   (`wrong_security_level`). It must be `ECDSA_SECP256K1` or `ECDSA_HASH160`
   (`unsupported_key_type`).
6. The signature recovers to that key (`invalid_signature`). For
   `ECDSA_SECP256K1` keys it compares the compressed public key, and for
   `ECDSA_HASH160` keys it compares the hash160.

### Security notes

- **Single-use nonces.** Issue a fresh random nonce per attempt on your server,
  bind it to the browser session, and delete it on first use, whether or not
  verification passes. That stops replay of a captured result.
- **Origin binding.** The signed message names your origin, and in popup or
  iframe mode the bridge posts the result only to that origin. Hard-code
  `expectedOrigin` on the server; never take it from the request. A result
  signed for another site fails with `origin_mismatch`.
- **Short expiry.** A proof is valid for 10 minutes, with 60 seconds of clock
  skew allowed.
- **HTTPS.** The bridge accepts only https origins (http only on localhost).
  Serve your app, and the result upload, over https.
- **Keys stay in the bridge.** The user pastes a WIF into the bridge, which
  fetches the identity's keys, checks that the WIF matches an enabled HIGH or
  CRITICAL AUTHENTICATION key, and shows the app (name and origin), identity,
  key and statement before the user clicks **Sign in**. MASTER keys are
  refused. The WIF is dropped from memory as soon as the message is signed or
  the request is cancelled. Results are built from a field whitelist and never
  contain private material.
- **The bridge never sees your session.** It only signs a message. Your server
  decides whether to start a session, and the bridge has no cookies or tokens
  of yours.
- **Verify keys from Platform.** Never verify against public keys sent by the
  client. Fetch them on the server, and use the same network you passed to
  `login()`.

Not covered: key exchange for end-to-end encrypted messaging, such as Yappr's
`dash-key:` protocol. That needs a contract that isn't deployed on mainnet yet.

## Local development

```bash
npm run dev
# Open http://localhost:5173/widget-demo.html
# Mock flow, no funds needed: http://localhost:5173/widget-demo.html?e2e=mock
```

In development, the demo page loads the SDK source. In production it loads
`/widget.mjs`. `npm run build` writes `dist/widget.js` and `dist/widget.mjs`
with `vite.widget.config.ts`, and `dist/widget-verify.mjs` with
`vite.verify.config.ts`. `scripts/check-build-artifacts.mjs` checks that all
three stay small and self-contained, that the SDK doesn't bundle the verifier,
and that the verifier loads in Node. The e2e suite (`e2e/widget.spec.ts`)
covers a cross-origin iframe host, the clickjacking guard, the SDK popup and
iframe flows, and sign-in in all three modes.

In mock mode (`?e2e=mock`), sign-in uses the mock identity
`4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA` with real keys from
`src/e2e-mock-constants.ts` (for example `E2E_MOCK_LOGIN_HIGH_WIF`), so the
demo page can verify the result for real.

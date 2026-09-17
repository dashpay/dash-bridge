# RPC dependency review — 2026-09-17

## Deployed baseline

The review and implementation start from `dashpay/dash-bridge` commit
`ab04c2f3316f573131673bf66fd682cf3ecc22a0`, the latest `origin/main` and latest
successful GitHub Pages deployment at the time of review.

- [Successful deployment run](https://github.com/dashpay/dash-bridge/actions/runs/33567685502), completed September 1, 2026, 22:45 UTC.
- GitHub Pages config names `bridge.thepasta.org`; the public host resolves to
  Cloudflare, and its response has GitHub Pages origin headers.
- The live HTML references `/assets/index-CoHZD5JG.js`, which contains both RPC
  hostnames and the deployed network configuration. Its Last-Modified header is
  September 1, 2026, 22:44:59 GMT.
- Both RPC hosts returned HTTP 200 to `getbestchainlock` and allowed the bridge
  origin in CORS preflight and POST responses during this review. The final
  implementation removes both hosts from the built-in mainnet/testnet config;
  the public networks use chain proofs directly. This establishes availability from the review environment, not universal
  reachability.

`trpc.digitalcash.dev` is testnet; `rpc.digitalcash.dev` is mainnet. They are
**not interchangeable fallbacks**. They also share an operator/domain failure
boundary. The bridge uses HTTPS, not WebSockets. Mainnet/testnet no longer
configure a Digital Cash RPC URL.

## What the bridge uses RPC for

| Operation | Deployed behavior | Behavior with this change |
| --- | --- | --- |
| Get an InstantSend lock (`getislocks`) | Single RPC provider; unbounded individual fetches could outlive the nominal 60-second poll timeout | No built-in provider. Explicit custom URLs have an 8-second request/body deadline and a 60-second overall deadline; three consecutive failures yield to chain recovery |
| Create identity, top up, send Core funds to a Platform address, recheck a deposit | Need an InstantSend proof, otherwise show an error requiring a manual recovery choice | Use a chain proof for the same broadcast asset-lock transaction |
| Create an identity while registering DPNS or a contract | Shares the identity-creation funding flow | Shares the same automatic recovery |
| Network-health indicator | Mainnet/testnet read `getbestchainlock` from the single RPC host, without observing Platform block age | Read Platform status through EvoSDK; only explicitly configured RPC URLs can act as a degraded health backup |
| Chain-proof recovery | Try RPC first; then legacy dapi-client seed/SML discovery, which had browser certificate/CORS failures | Read Platform's chain-lock height through EvoSDK on public networks; retain explicit DAPI addresses on devnets |
| Existing-identity DPNS, key management, username transfers, withdrawals | Platform SDK operations; no direct RPC requirement for their operation | Unchanged operation dependency; header health no longer normally calls RPC |

The deployed DAPI InstantSend stream is used only for devnets without an RPC
URL. It must be open before broadcast and does not replay historical locks.
Public networks use chain-proof recovery when no optional RPC URL is supplied;
legacy browser discovery is never required for recovery.

## Recovery guarantees and limits

Recovery polls the transaction and Platform in parallel. It submits only after
Insight reports a positive, integral confirming block height and Platform
reports a chain-locked height at least that high. Confirmation count alone is
insufficient. Each poll uses fresh transaction information, avoiding reuse of
an earlier block height after a reorg or failed read. Platform still validates
the submitted proof and asset lock.

Cancellation preserves the transaction and keys in the existing in-memory
state and allows the same chain-lock wait to resume. Recovery neither builds
nor broadcasts a second asset lock. Transaction data and keys are not persisted
by this change; closing/reloading the page still requires the existing key
backup/recovery process.

Recovery can take minutes while the transaction is mined and Platform observes
its chain lock. It cannot complete if Platform consensus stalls or the remaining
required services are unreachable. The wait is cancellable. Individual public
Platform status reads have a 20-second wall-clock guard; SDK requests retain
normal node rotation/retry behavior. The wrapper does not cancel an underlying
WASM request, but a late result cannot submit a proof after cancellation.

## Remaining bridge dependencies

| Dependency | Purpose | Existing fallback / limitation |
| --- | --- | --- |
| Insight (`insight.testnet.networks.dash.org`, `insight.dash.org`, configured devnet Insight) | Deposit UTXOs, transaction broadcast, confirming block height, Core health | Retries on the same provider; no independent explorer failover. Blocking Insight still prevents the relevant funding/recovery steps. |
| `@dashevo/evo-sdk` trusted quorum service (`quorums.<network>.networks.dash.org`) | Quorum context and Platform node discovery on public/trusted networks | SDK caches context and rotates discovered Platform nodes; no independently configured quorum-context provider for mainnet/testnet. A cold connection needs this service. |
| Platform evonodes | Status and identity/credit/DPNS/contract operations | SDK retries/rotates nodes; a network-wide outage has no application substitute. |
| Configured DAPI nodes on devnets | Pre-broadcast InstantSend stream and Platform status | Multiple explicit addresses; stream failure can use chain recovery after broadcast. Subscription setup failure still stops before broadcast. |
| `faucet.thepasta.org` and CAPTCHA services | Optional testnet funding button | Users can fund the deposit address themselves. This is not required to bridge their own funds. |
| Platform Explorer links | External transaction/identity viewing | Display/navigation only; not part of proof creation or submission. |
| Cloudflare + GitHub Pages | Deliver the app | No alternate app origin is configured in this repository. |

## Validation

- Production TypeScript/Vite build and build-artifact smoke check passed;
  the artifact check rejects any bundled `digitalcash.dev` endpoint.
- Unit coverage for blocked/invalid RPC responses, matching lock parsing,
  polling deadlines, request cancellation, mining/chain-lock readiness,
  reorg/read-failure handling, and late responses after cancellation.
- Deterministic Chromium outage tests execute the real signing and bridge
  orchestration with every external request intercepted. They verify one
  broadcast, no premature submission, a chain proof for the same transaction,
  and cancellation/resume on both mainnet and testnet, across create, top-up,
  send-to-address, and deposit recheck. Every test blocks the domain with a DNS
  error and asserts zero requests to it. Broadcast and Platform submission are fixtures;
  these tests do not spend funds.
- A separate live, read-only Chromium check blocked both Digital Cash RPC
  hosts and exercised the new `IslockService`/`fetchNetworkStatus` code. Testnet
  reported Core 1,555,588 / Platform chain-lock 1,555,586; mainnet reported
  2,540,454 / 2,540,454. Both health results were healthy and no RPC request was
  attempted. These heights are a dated observation, not a future health claim.
- No funded live end-to-end transaction or production deployment was performed
  during this review.

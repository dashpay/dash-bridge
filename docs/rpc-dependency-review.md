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
  origin in CORS preflight and POST responses during this review. This establishes
  availability from the review environment, not universal reachability.

`trpc.digitalcash.dev` is testnet; `rpc.digitalcash.dev` is mainnet. They are
**not interchangeable fallbacks**. They also share an operator/domain failure
boundary. The bridge uses HTTPS, not WebSockets.

## What the bridge uses RPC for

| Operation | Deployed behavior | Behavior with this change |
| --- | --- | --- |
| Get an InstantSend lock (`getislocks`) | Single RPC provider; unbounded individual fetches could outlive the nominal 60-second poll timeout | Optional fast path, 8-second request/body deadline, 60-second total poll deadline; three consecutive failures yield to chain recovery |
| Create identity, top up, send Core funds to a Platform address, recheck a deposit | Need an InstantSend proof, otherwise show an error requiring a manual recovery choice | Automatically recover the same broadcast asset-lock transaction with a chain proof |
| Create an identity while registering DPNS or a contract | Shares the identity-creation funding flow | Shares the same automatic recovery |
| Network-health indicator | Mainnet/testnet read `getbestchainlock` from the single RPC host, without observing Platform block age | Read Platform status through EvoSDK; Core RPC is only a degraded health backup |
| Chain-proof recovery | Try RPC first; then legacy dapi-client seed/SML discovery, which had browser certificate/CORS failures | Read Platform's chain-lock height through EvoSDK on public networks; retain explicit DAPI addresses on devnets |
| Existing-identity DPNS, key management, username transfers, withdrawals | Platform SDK operations; no direct RPC requirement for their operation | Unchanged operation dependency; header health no longer normally calls RPC |

The deployed DAPI InstantSend stream is used only for devnets without an RPC
URL. It must be open before broadcast and does not replay historical locks.
Mainnet/testnet deliberately skip it because legacy browser discovery failed.
The new implementation preserves that routing instead of relying on this
stream to recover a transaction after its InstantSend event has passed.

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

## Other consumers found

This inventory covers matching code in the available workspaces, followed by
checks against each listed repository's current GitHub default branch. It is
not an exhaustive inventory of every Internet client of the RPC service.
Other repositories were inspected without modification.

| Consumer and inspected revision | Usage | What happens if RPC is blocked/down |
| --- | --- | --- |
| [dash-faucet-cf](https://github.com/PastaPastaPasta/dash-faucet-cf/tree/8b2b589a5b15bf0214cadc9308bb42e6d3a139d2) | Both RPC hosts for chain reads and broadcasts | Provider failover already exists: testnet Insight; mainnet Hyphen and Insight for reads, Insight for broadcast. Reads reject lagging providers and broadcasts fan out. Live faucet status reported `source: insight`, with both Insight and RPC healthy during review. **Exception: invitation ChainLock checks implement only the RPC provider**, so new invitation inventory can remain awaiting confirmation when RPC is unavailable, even though ordinary payouts keep working. Already available invitations can still be issued. |
| [dash-forge identity minting](https://github.com/PastaPastaPasta/dash-forge/tree/b50ecf7988dc79120287a2e7362f0104d8e8f81b/tools/mint-identity) | Testnet `getislocks` after broadcasting an asset lock for create/top-up; implementation was copied from the bridge | Exponential polling backoff, but no independent proof/provider fallback. A blocked host eventually fails provisioning; a hanging fetch can exceed the outer timeout. Follow-up candidate for this recovery approach. |
| [dash-mn-map updater](https://github.com/PastaPastaPasta/dash-mn-map/blob/79cd31c326725e4e461c882baaa07edae3a50084/.github/workflows/update_masternodes.yml) | Daily mainnet `masternodelist` refresh | No alternate provider. The deployed map uses committed JSON, so existing data can remain usable while refresh is unavailable/stale. Latest observed refresh succeeded September 17. |
| [Platform Basics](https://github.com/PastaPastaPasta/dash-platform-basics/tree/a067d6fe94091c342d939630822e8c42598667b0) (`all-dpns`, `get-identities`) | Mainnet masternode discovery before DPNS queries | Retries different discovered DAPI nodes only after RPC discovery succeeds. RPC failure stops the mainnet lookup; no discovery fallback. Testnet follows a separate SDK path. |

Additional matches in Dash MNO verification notes and orchestration memories
were documentation, not established runtime dependencies.

## Validation

- Production TypeScript/Vite build and build-artifact smoke check passed.
- 129 unit tests and 10 Chromium tests passed.
- Unit coverage for blocked/invalid RPC responses, matching lock parsing,
  polling deadlines, request cancellation, mining/chain-lock readiness,
  reorg/read-failure handling, and late responses after cancellation.
- Deterministic Chromium outage tests execute the real signing and bridge
  orchestration with every external request intercepted. They verify one
  broadcast, no premature submission, a chain proof for the same transaction,
  and cancellation/resume. Broadcast and Platform submission are fixtures;
  these tests do not spend funds.
- A separate live, read-only Chromium check blocked both Digital Cash RPC
  hosts and exercised the new `IslockService`/`fetchNetworkStatus` code. Testnet
  reported Core 1,555,588 / Platform chain-lock 1,555,586; mainnet reported
  2,540,454 / 2,540,454. Both health results were healthy and no RPC request was
  attempted. These heights are a dated observation, not a future health claim.
- No funded live end-to-end transaction or production deployment was performed
  during this review.

## Implementation review

**Findings:** No blocking findings in the final implementation. The remaining
Insight/quorum-context dependencies and lack of a funded live submission are
explicit limitations above.

**Approval status:** APPROVED after correctness, maintainability, architecture,
and security/reliability review of the actual diff.

**Simplification:** Consolidated the four identical broadcast/wait sequences,
replaced the two shared-state recovery pollers with one testable readiness loop,
and unified bounded JSON reads. Kept devnet discovery and unrelated Platform
operations within their existing implementations. Removed duplicated RPC URL
constants in favor of the network configuration.

import platformChunkUrl from 'virtual:chunk-url:./index.js';
import dpnsChunkUrl from 'virtual:chunk-url:./dpns.js';
import contractChunkUrl from 'virtual:chunk-url:./contract.js';
import usernameTransferChunkUrl from 'virtual:chunk-url:./username-transfer.js';
import feeEstimatorChunkUrl from 'virtual:chunk-url:dash-contract-fee-estimator';
import islockChunkUrl from 'virtual:chunk-url:../api/islock.js';
import { getNetwork } from '../config.js';
import { createChunkLoader, withChunkTimeout } from './chunk-loader.js';
import { loadSdkModule } from './sdkModule.js';

export const loadPlatformModule = createChunkLoader('platform', platformChunkUrl, () => import('./index.js'));
export const loadDpnsModule = createChunkLoader('dpns', dpnsChunkUrl, () => import('./dpns.js'));
export const loadContractModule = createChunkLoader('contract', contractChunkUrl, () => import('./contract.js'));
export const loadUsernameTransferModule = createChunkLoader(
  'username-transfer',
  usernameTransferChunkUrl,
  () => import('./username-transfer.js')
);
// client.ts is statically imported by other platform modules, so it lives in
// the main chunk and this import never fetches anything: no chunk URL needed.
export const loadPlatformClientModule = createChunkLoader('platform-client', null, () => import('./client.js'));
export const loadFeeEstimatorModule = createChunkLoader(
  'fee-estimator',
  feeEstimatorChunkUrl,
  () => import('dash-contract-fee-estimator')
);
export const loadIslockModule = createChunkLoader('islock', islockChunkUrl, () => import('../api/islock.js'));

export function warmDashModules(): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled([
    loadPlatformModule(),
    loadDpnsModule(),
    loadContractModule(),
    loadUsernameTransferModule(),
    loadPlatformClientModule(),
    loadFeeEstimatorModule(),
    loadIslockModule(),
  ]);
}

/**
 * Load the chunks a Platform submission needs (EvoSDK and platform
 * operations), for the funding gate in main.ts. Rejects with a ChunkLoadError
 * naming the chunk when it still fails after the loaders' retries, or is
 * still loading after `timeoutMs` (the SDK is ~7 MB gzipped: 5 min covers
 * about 200 kbit/s; Reload would throw a partial download away).
 */
export async function loadPlatformForFunding(timeoutMs = 5 * 60_000): Promise<void> {
  await Promise.all([
    withChunkTimeout(loadSdkModule(), 'evo-sdk', timeoutMs),
    withChunkTimeout(loadPlatformModule(), 'platform', timeoutMs),
  ]);
}

/**
 * Start connecting the EvoSDK when the user enters a funding flow (create,
 * top-up, send-to-address), before any funds can be committed. Registration
 * needs the SDK anyway; connecting early means the health indicator can read
 * real Platform status before the asset lock is broadcast. Idle visitors never
 * reach a funding flow, so they still never download it.
 *
 * Testnet only: other networks keep their existing status sources (JSON-RPC on
 * mainnet, dapi-client on devnets) and are not touched. Fire and forget: a
 * failed connect is logged and later shows up as a degraded health verdict; it
 * never blocks funding. Concurrent and repeated calls share one connect.
 * Resolves true once a connect was attempted (settled either way), false when
 * the network is not testnet and nothing was started.
 */
export function warmPlatformSdkForFunding(network: string): Promise<boolean> {
  if (getNetwork(network).type !== 'testnet') return Promise.resolve(false);
  return loadPlatformClientModule()
    .then(({ connectPlatformSdk }) => connectPlatformSdk(network))
    .then(
      () => true,
      (error) => {
        console.warn('Platform SDK warmup failed:', error);
        return true;
      }
    );
}

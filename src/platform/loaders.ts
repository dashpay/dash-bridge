import { getNetwork } from '../config.js';

export function createCachedLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) {
      promise = load().catch((err) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
}

export const loadPlatformModule = createCachedLoader(() => import('./index.js'));
export const loadDpnsModule = createCachedLoader(() => import('./dpns.js'));
export const loadContractModule = createCachedLoader(() => import('./contract.js'));
export const loadUsernameTransferModule = createCachedLoader(() => import('./username-transfer.js'));
export const loadPlatformClientModule = createCachedLoader(() => import('./client.js'));
export const loadFeeEstimatorModule = createCachedLoader(() => import('dash-contract-fee-estimator'));
export const loadIslockModule = createCachedLoader(() => import('../api/islock.js'));

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
 */
export function warmPlatformSdkForFunding(network: string): Promise<void> {
  if (getNetwork(network).type !== 'testnet') return Promise.resolve();
  return loadPlatformClientModule()
    .then(({ connectPlatformSdk }) => connectPlatformSdk(network))
    .then(
      () => undefined,
      (error) => console.warn('Platform SDK warmup failed:', error)
    );
}

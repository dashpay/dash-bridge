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
export const loadPlatformClientModule = createCachedLoader(() => import('./client.js'));
export const loadFeeEstimatorModule = createCachedLoader(() => import('dash-contract-fee-estimator'));
export const loadIslockModule = createCachedLoader(() => import('../api/islock.js'));

export function warmDashModules(): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled([
    loadPlatformModule(),
    loadDpnsModule(),
    loadContractModule(),
    loadPlatformClientModule(),
    loadFeeEstimatorModule(),
    loadIslockModule(),
  ]);
}

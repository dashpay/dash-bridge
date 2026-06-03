function cached<T>(load: () => Promise<T>): () => Promise<T> {
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

export const loadPlatformModule = cached(() => import('./index.js'));
export const loadDpnsModule = cached(() => import('./dpns.js'));
export const loadContractModule = cached(() => import('./contract.js'));
export const loadPlatformClientModule = cached(() => import('./client.js'));
export const loadFeeEstimatorModule = cached(() => import('dash-contract-fee-estimator'));
export const loadIslockModule = cached(() => import('../api/islock.js'));

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

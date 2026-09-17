import type { InsightClient } from './insight.js';
import type { IslockService } from './islock.js';
import { abortableSleep } from '../utils/sleep.js';

/** Wait for a mined transaction AND a real Platform-observed chain lock. */
export async function waitForChainLock(
  txid: string,
  insight: InsightClient,
  islock: IslockService,
  signal: AbortSignal,
  onProgress: (progress: { blockHeight?: number; chainLockedHeight?: number }) => void
): Promise<number> {
  while (!signal.aborted) {
    // Platform reads cannot be aborted inside the SDK. Release this wait
    // promptly and ignore their eventual results when the user cancels.
    let onAbort = (): void => {};
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let results;
    try {
      results = await Promise.race([
        Promise.allSettled([
          insight.getTransaction(txid, { maxAttempts: 1 }, signal),
          islock.getCoreChainLockedHeight(),
        ]),
        cancelled,
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (!results || signal.aborted) break;
    const [tx, chain] = results;
    const blockHeight = tx.status === 'fulfilled' ? tx.value.blockheight : undefined;
    const chainLockedHeight = chain.status === 'fulfilled' ? chain.value : undefined;
    onProgress({ blockHeight, chainLockedHeight });
    // Never infer a chain lock from confirmation count or an old UI snapshot.
    if (blockHeight !== undefined && Number.isSafeInteger(blockHeight) && blockHeight > 0 &&
        chainLockedHeight !== undefined && Number.isSafeInteger(chainLockedHeight) && chainLockedHeight >= blockHeight) {
      return blockHeight;
    }
    await abortableSleep(5000, signal);
  }
  throw new Error('Chain-lock wait cancelled');
}

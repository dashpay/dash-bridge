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
    const [tx, chain] = await Promise.allSettled([
      insight.getTransaction(txid, { maxAttempts: 1 }, signal),
      islock.getCoreChainLockedHeight(),
    ]);
    if (signal.aborted) break;
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

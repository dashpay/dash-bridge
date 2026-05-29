import type { InsightClient } from './insight.js';
import type { IslockService } from './islock.js';
import type { NetworkHealth, NetworkStatus } from '../types.js';

/**
 * Network-health heuristics. Tuned for Dash Platform: a healthy chain-lock
 * tracks Core within a handful of blocks, and Tenderdash produces blocks every
 * few seconds, so a Platform block more than a few minutes old means consensus
 * is stalling.
 */
const CHAIN_LOCK_LAG_DEGRADED = 8; // blocks behind Core's tip
const CHAIN_LOCK_LAG_STALLED = 30;
const PLATFORM_BLOCK_AGE_DEGRADED_MS = 5 * 60_000;
const PLATFORM_BLOCK_AGE_STALLED_MS = 15 * 60_000;

// Escalation ranking for the worst-wins verdict. `unknown` is intentionally
// omitted: it is only ever produced by the explicit early-return path (both
// sources unreachable) and is never passed to `escalate()`.
const HEALTH_RANK: Record<Exclude<NetworkHealth, 'unknown'>, number> = {
  healthy: 0,
  degraded: 1,
  stalled: 2,
};

/**
 * Gather Core (Insight) and Platform (DAPI) status and derive an overall
 * health verdict. Both sources are queried in parallel and tolerated
 * individually: a verdict is produced from whatever responds.
 */
export async function fetchNetworkStatus(
  insight: InsightClient,
  islock: IslockService
): Promise<NetworkStatus> {
  const checkedAtMs = Date.now();

  // Bound the Insight retry so a flaky endpoint can't stretch one poll past the
  // 30s interval (the dapi-client behind getPlatformStatus has its own timeout).
  const [coreResult, platformResult] = await Promise.allSettled([
    insight.getBlockHeight({ maxAttempts: 1 }),
    islock.getPlatformStatus(),
  ]);

  const coreHeight = coreResult.status === 'fulfilled' ? coreResult.value : undefined;
  const platform = platformResult.status === 'fulfilled' ? platformResult.value : undefined;

  const coreChainLockedHeight = platform?.coreChainLockedHeight;
  const platformBlockHeight = platform?.latestBlockHeight;
  const platformBlockTimeMs = platform?.latestBlockTimeMs;

  const reasons: string[] = [];
  let health: Exclude<NetworkHealth, 'unknown'> = 'healthy';
  const escalate = (level: Exclude<NetworkHealth, 'unknown'>): void => {
    if (HEALTH_RANK[level] > HEALTH_RANK[health]) health = level;
  };

  const coreReachable = coreHeight !== undefined;
  const platformReachable = platform !== undefined;

  // Nothing answered — we can't say anything useful.
  if (!coreReachable && !platformReachable) {
    return {
      health: 'unknown',
      reasons: ['Could not reach Insight or Platform'],
      checkedAtMs,
    };
  }

  if (!coreReachable) {
    escalate('degraded');
    reasons.push('Insight (Core) unreachable');
  }
  if (!platformReachable) {
    // "Unreachable" is a transport failure, not an observed consensus stall —
    // flag it as degraded so a transient DAPI error doesn't fire a false red
    // "stalled" alarm. A genuine stall shows up via the lag/age checks below.
    escalate('degraded');
    reasons.push('Platform (DAPI) status unreachable');
  }

  // Chain-lock lag: Core advancing while Platform's chain-locked height trails.
  let chainLockLag: number | undefined;
  if (coreHeight !== undefined && coreChainLockedHeight !== undefined) {
    chainLockLag = coreHeight - coreChainLockedHeight;
    if (chainLockLag >= CHAIN_LOCK_LAG_STALLED) {
      escalate('stalled');
      reasons.push(
        `Platform chain-lock is ${chainLockLag} blocks behind Core (${coreChainLockedHeight} vs ${coreHeight})`
      );
    } else if (chainLockLag >= CHAIN_LOCK_LAG_DEGRADED) {
      escalate('degraded');
      reasons.push(
        `Platform chain-lock is ${chainLockLag} blocks behind Core (${coreChainLockedHeight} vs ${coreHeight})`
      );
    }
  }

  // Platform block age: stale Tenderdash blocks mean consensus is stuck.
  // DAPI's getStatus time.block is Unix milliseconds (13 digits, e.g.
  // 1780014886480), distinct from time.local which is Unix seconds — so it's
  // directly comparable to Date.now().
  let platformBlockAgeMs: number | undefined;
  if (platformBlockTimeMs !== undefined && platformBlockTimeMs > 0) {
    platformBlockAgeMs = checkedAtMs - platformBlockTimeMs;
    if (platformBlockAgeMs >= PLATFORM_BLOCK_AGE_STALLED_MS) {
      escalate('stalled');
      reasons.push(`Latest Platform block is ${formatAge(platformBlockAgeMs)} old`);
    } else if (platformBlockAgeMs >= PLATFORM_BLOCK_AGE_DEGRADED_MS) {
      escalate('degraded');
      reasons.push(`Latest Platform block is ${formatAge(platformBlockAgeMs)} old`);
    }
  }

  return {
    health,
    coreHeight,
    coreChainLockedHeight,
    platformBlockHeight,
    platformBlockTimeMs,
    chainLockLag,
    platformBlockAgeMs,
    reasons,
    checkedAtMs,
  };
}

/** Compact human-readable age, e.g. "12m" or "3h 5m". */
export function formatAge(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

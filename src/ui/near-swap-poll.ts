/**
 * Status polling for an open NEAR Intents swap. Kept apart from main.ts, with
 * its effects injected, so the lifecycle rules can be unit-tested.
 */

import type { BridgeState } from '../types.js';
import { isNearSwapExpired, type NearSwapStatus } from '../api/near-intents.js';
import { setNearSwapStatus, shouldRecheckAfterNearSwap } from './state.js';
import { abortableSleep } from '../utils/sleep.js';
import { extractErrorMessage } from '../utils/errors.js';

export const NEAR_STATUS_POLL_MS = 5000;
/** Recheck rounds started on the user's behalf after a delivered swap. */
export const NEAR_MAX_AUTO_RECHECKS = 3;
/** How long to keep polling an unpaid swap after its deadline. */
export const NEAR_EXPIRED_POLL_GRACE_MS = 30 * 60 * 1000;

export interface NearSwapPollDeps {
  getState(): BridgeState;
  /** Commit a new state and re-render. */
  setState(next: BridgeState): void;
  getStatus(depositAddress: string, depositMemo: string | undefined, signal: AbortSignal): Promise<NearSwapStatus>;
  /** Restart the bridge's own deposit poll (the "Check Again" action). */
  recheckDeposit(): Promise<void>;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
}

/** Whether this swap is still the one on the deposit screen. */
export function isTrackingNearSwap(state: BridgeState, depositAddress: string): boolean {
  const swap = state.nearIntents?.swap;
  return (
    (state.step === 'awaiting_deposit' || state.step === 'detecting_deposit') &&
    swap?.depositAddress === depositAddress &&
    swap.recipient === state.depositAddress
  );
}

/**
 * Track the swap until it settles. Keeps running while the deposit screen
 * shows "Check Again" after the deposit poll's own timeout, and once DASH is
 * delivered restarts that poll (at most NEAR_MAX_AUTO_RECHECKS times) so the
 * bridge continues without a click. Stops when aborted, when the swap is
 * refunded/failed, when it stays unpaid well past its deadline, or when the
 * user leaves the deposit screen or the deposit address changes.
 */
export async function pollNearSwap(
  depositAddress: string,
  depositMemo: string | undefined,
  signal: AbortSignal,
  deps: NearSwapPollDeps
): Promise<void> {
  const sleep = deps.sleep ?? abortableSleep;
  const now = deps.now ?? Date.now;
  const tracking = () => !signal.aborted && isTrackingNearSwap(deps.getState(), depositAddress);
  let autoRechecks = 0;
  let expiryShown = false;

  while (tracking()) {
    const current = deps.getState().nearIntents!.swap!;
    if (current.status === 'SUCCESS') {
      // Delivered: nothing left to ask NEAR Intents. Just make sure a deposit
      // poll is running until the bridge moves past the deposit step.
      if (shouldRecheckAfterNearSwap(deps.getState()) && autoRechecks < NEAR_MAX_AUTO_RECHECKS) {
        autoRechecks += 1;
        deps.recheckDeposit().catch((error) => console.warn('Deposit recheck after NEAR swap failed:', error));
      }
    } else {
      if (isNearSwapExpired(current, now())) {
        // Re-render once so the stale payment address is hidden. Keep
        // listening a while in case a last-second payment still shows up.
        if (!expiryShown) {
          expiryShown = true;
          deps.setState(deps.getState());
        }
        if (now() > Date.parse(current.deadline) + NEAR_EXPIRED_POLL_GRACE_MS) break;
      }
      try {
        const status = await deps.getStatus(depositAddress, depositMemo, signal);
        if (!tracking()) break;
        const swap = deps.getState().nearIntents!.swap!;
        if (swap.status !== status || swap.statusError) {
          deps.setState(setNearSwapStatus(deps.getState(), depositAddress, { status }));
        }
        if (status === 'REFUNDED' || status === 'FAILED') break;
        if (status === 'SUCCESS') continue;
      } catch (error) {
        if (!tracking()) break;
        const statusError = extractErrorMessage(error);
        if (deps.getState().nearIntents!.swap!.statusError !== statusError) {
          deps.setState(setNearSwapStatus(deps.getState(), depositAddress, { statusError }));
        }
      }
    }
    await sleep(NEAR_STATUS_POLL_MS, signal);
  }
}

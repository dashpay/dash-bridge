import type { BridgeState, NetworkStatus } from '../types.js';

export interface NetworkStatusSyncDeps {
  getState(): BridgeState;
  /** Replace the app state without re-rendering. */
  setStateQuietly(state: BridgeState): void;
  /** Replace the app state and re-render. */
  updateState(state: BridgeState): void;
  /** Patch the visible indicator's tooltip in place. */
  refreshTooltip(status: NetworkStatus): void;
}

export interface NetworkStatusSync {
  /** Take a fresh poll result. */
  apply(network: string, status: NetworkStatus): void;
  /**
   * Re-attach the last known status to a state that lacks one (a flow reset
   * builds a fresh state), so the indicator doesn't vanish until a poll's
   * verdict happens to change. Never carries a status across networks.
   */
  carryOver(state: BridgeState): BridgeState;
  /** Forget everything, e.g. when polling restarts for another network. */
  reset(): void;
}

/** What the banner and the indicator label depend on; the numbers are not part of it. */
function verdictKey(status: NetworkStatus): string {
  return `${status.health}|${status.reasons.join('|')}`;
}

/**
 * Keeps `state.networkStatus` current. Every poll result is stored, so reads of
 * the state (and the next render) always see fresh numbers. A full re-render
 * happens only when the verdict or its reasons change, because that is all the
 * banner and the indicator label show; otherwise just the tooltip is patched in
 * place, which avoids re-rendering (and disturbing focus) every 30 seconds.
 */
export function createNetworkStatusSync(deps: NetworkStatusSyncDeps): NetworkStatusSync {
  let last: { network: string; status: NetworkStatus } | undefined;

  return {
    apply(network, status) {
      const state = deps.getState();
      // A poller of a network the user already left must not write into the new one.
      if (network !== state.network) return;
      last = { network, status };

      // Compare with what is on screen (the state), not with the previous poll:
      // the state may have been replaced in between.
      const shown = state.networkStatus;
      if (!shown || verdictKey(shown) !== verdictKey(status)) {
        deps.updateState({ ...state, networkStatus: status });
        return;
      }
      deps.setStateQuietly({ ...state, networkStatus: status });
      deps.refreshTooltip(status);
    },

    carryOver(state) {
      if (state.networkStatus || !last || last.network !== state.network) return state;
      return { ...state, networkStatus: last.status };
    },

    reset() {
      last = undefined;
    },
  };
}

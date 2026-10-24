import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createNetworkStatusSync } from './network-status-sync.js';
import { createInitialState } from './state.js';
import type { BridgeState, NetworkStatus } from '../types.js';

const status = (overrides: Partial<NetworkStatus> = {}): NetworkStatus => ({
  health: 'healthy',
  coreHeight: 1_578_205,
  coreChainLockedHeight: 1_578_204,
  platformBlockHeight: 641_243,
  platformBlockAgeMs: 60_000,
  reasons: [],
  checkedAtMs: 1,
  ...overrides,
});

function setup(network = 'testnet') {
  let state: BridgeState = createInitialState(network);
  const updateState = vi.fn((next: BridgeState) => {
    state = next;
  });
  const refreshTooltip = vi.fn();
  const sync = createNetworkStatusSync({
    getState: () => state,
    setStateQuietly: (next) => {
      state = next;
    },
    updateState,
    refreshTooltip,
  });
  return {
    sync,
    updateState,
    refreshTooltip,
    get state() {
      return state;
    },
    set state(next: BridgeState) {
      state = next;
    },
  };
}

describe('createNetworkStatusSync', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('renders the first status', () => {
    const first = status();
    ctx.sync.apply('testnet', first);

    expect(ctx.updateState).toHaveBeenCalledOnce();
    expect(ctx.state.networkStatus).toBe(first);
    expect(ctx.refreshTooltip).not.toHaveBeenCalled();
  });

  it('keeps the state fresh and patches only the tooltip while the verdict is unchanged', () => {
    ctx.sync.apply('testnet', status());
    ctx.updateState.mockClear();

    // 8 polls with moving numbers and the same verdict (the case that stayed stuck).
    for (let i = 1; i <= 8; i++) {
      const fresh = status({
        coreHeight: 1_578_205 + i,
        platformBlockHeight: 641_243 + i * 5,
        platformBlockAgeMs: 60_000 + i * 1000,
      });
      ctx.sync.apply('testnet', fresh);
      expect(ctx.state.networkStatus).toBe(fresh);
      expect(ctx.refreshTooltip).toHaveBeenLastCalledWith(fresh);
    }

    expect(ctx.refreshTooltip).toHaveBeenCalledTimes(8);
    expect(ctx.updateState).not.toHaveBeenCalled(); // no needless re-render
  });

  it('re-renders when the verdict or its reasons change', () => {
    ctx.sync.apply('testnet', status());
    ctx.updateState.mockClear();

    ctx.sync.apply('testnet', status({ health: 'degraded', reasons: ['Insight (Core) unreachable'] }));
    expect(ctx.updateState).toHaveBeenCalledTimes(1);

    ctx.sync.apply('testnet', status({ health: 'degraded', reasons: ['Platform (DAPI) status unreachable'] }));
    expect(ctx.updateState).toHaveBeenCalledTimes(2);

    ctx.sync.apply('testnet', status());
    expect(ctx.updateState).toHaveBeenCalledTimes(3);
    expect(ctx.refreshTooltip).not.toHaveBeenCalled();
  });

  it('renders again when an unchanged verdict arrives but the state lost its status', () => {
    ctx.sync.apply('testnet', status());
    ctx.updateState.mockClear();
    ctx.state = createInitialState('testnet'); // a reset that bypassed carryOver

    const fresh = status({ coreHeight: 1_578_300 });
    ctx.sync.apply('testnet', fresh);

    expect(ctx.updateState).toHaveBeenCalledOnce();
    expect(ctx.state.networkStatus).toBe(fresh);
    expect(ctx.refreshTooltip).not.toHaveBeenCalled();
  });

  describe('carryOver', () => {
    it('restores the last known status after a state reset', () => {
      const last = status({ coreHeight: 1_578_400 });
      ctx.sync.apply('testnet', status());
      ctx.sync.apply('testnet', last);

      const reset = createInitialState('testnet'); // Try Again / Contract -> Back
      expect(reset.networkStatus).toBeUndefined();
      expect(ctx.sync.carryOver(reset).networkStatus).toBe(last);
    });

    it('leaves a state that already has a status alone', () => {
      ctx.sync.apply('testnet', status());
      const own = status({ coreHeight: 1 });
      const state = { ...createInitialState('testnet'), networkStatus: own };

      expect(ctx.sync.carryOver(state)).toBe(state);
    });

    it('does nothing before the first poll', () => {
      const state = createInitialState('testnet');
      expect(ctx.sync.carryOver(state)).toBe(state);
    });

    it('never carries a status across networks', () => {
      ctx.sync.apply('testnet', status());
      const mainnet = createInitialState('mainnet');

      expect(ctx.sync.carryOver(mainnet).networkStatus).toBeUndefined();
    });

    it('forgets the status on reset()', () => {
      ctx.sync.apply('testnet', status());
      ctx.sync.reset();

      expect(ctx.sync.carryOver(createInitialState('testnet')).networkStatus).toBeUndefined();
    });
  });

  it('after reset(), the next poll renders even with an unchanged verdict', () => {
    ctx.sync.apply('testnet', status());
    ctx.sync.reset();
    ctx.updateState.mockClear();

    ctx.sync.apply('testnet', status());
    expect(ctx.updateState).toHaveBeenCalledOnce();
  });
});

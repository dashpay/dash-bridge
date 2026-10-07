import { describe, it, expect, vi } from 'vitest';

import { pollNearSwap, NEAR_MAX_AUTO_RECHECKS, NEAR_EXPIRED_POLL_GRACE_MS, type NearSwapPollDeps } from './near-swap-poll.js';
import { createInitialState, setDepositTimedOut, setNearIntentsSwap } from './state.js';
import type { BridgeState, NearIntentsSwap } from '../types.js';
import type { NearSwapStatus } from '../api/near-intents.js';

const BRIDGE_ADDRESS = 'XanAvE5GMB8CsPH78B9moJq9viEVKvCS4f';
const NOW = Date.parse('2026-10-07T17:00:00.000Z');
const SWAP: NearIntentsSwap = {
  depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8',
  recipient: BRIDGE_ADDRESS,
  refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D',
  originAssetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  symbol: 'USDC',
  blockchain: 'eth',
  decimals: 6,
  amountIn: '2680000',
  amountOut: '5000000',
  deadline: '2026-10-07T18:00:00.000Z',
  status: 'PENDING_DEPOSIT',
};

function swapState(swap: Partial<NearIntentsSwap> = {}, overrides: Partial<BridgeState> = {}): BridgeState {
  return setNearIntentsSwap(
    { ...createInitialState('mainnet'), step: 'detecting_deposit', depositAddress: BRIDGE_ADDRESS, ...overrides },
    { ...SWAP, ...swap }
  );
}

/**
 * A harness around pollNearSwap with an in-memory state, a scripted status
 * sequence and a sleep that runs `onTick` and aborts after `maxTicks`.
 */
function harness(initial: BridgeState, opts: {
  statuses?: (NearSwapStatus | Error)[];
  recheck?: (h: { state: BridgeState }) => void;
  onTick?: (tick: number, h: { state: BridgeState }) => void;
  maxTicks?: number;
  now?: () => number;
} = {}) {
  const h = { state: initial };
  const controller = new AbortController();
  const statuses = [...(opts.statuses ?? [])];
  let ticks = 0;
  const deps: NearSwapPollDeps = {
    getState: () => h.state,
    setState: vi.fn((next: BridgeState) => { h.state = next; }),
    getStatus: vi.fn(async () => {
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0] ?? 'PENDING_DEPOSIT';
      if (next instanceof Error) throw next;
      return next;
    }),
    recheckDeposit: vi.fn(async () => { opts.recheck?.(h); }),
    sleep: vi.fn(async () => {
      ticks += 1;
      opts.onTick?.(ticks, h);
      if (ticks >= (opts.maxTicks ?? 20)) controller.abort();
    }),
    now: opts.now ?? (() => NOW),
  };
  const run = () => pollNearSwap(SWAP.depositAddress, undefined, controller.signal, deps);
  return { h, deps, run, ticks: () => ticks };
}

describe('pollNearSwap', () => {
  it('follows the status, then rechecks the timed-out deposit poll once DASH is delivered', async () => {
    const t = harness(swapState(), {
      statuses: ['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS'],
      // The bridge's own deposit wait gives up while the swap is processing.
      onTick: (tick, h) => { if (tick === 1) h.state = setDepositTimedOut(h.state, true, 0); },
      recheck: (h) => { h.state = setDepositTimedOut(h.state, false, 0); },
      maxTicks: 6,
    });
    await t.run();
    expect(t.h.state.nearIntents!.swap!.status).toBe('SUCCESS');
    expect(t.deps.getStatus).toHaveBeenCalledTimes(3);
    expect(t.deps.recheckDeposit).toHaveBeenCalledTimes(1);
  });

  it(`starts at most ${NEAR_MAX_AUTO_RECHECKS} rechecks even if the deposit poll keeps timing out`, async () => {
    const t = harness(setDepositTimedOut(swapState({ status: 'SUCCESS' }), true, 0), {
      // Each recheck "times out" again straight away.
      recheck: (h) => { h.state = setDepositTimedOut(h.state, true, 0); },
      maxTicks: 20,
    });
    await t.run();
    expect(t.deps.recheckDeposit).toHaveBeenCalledTimes(NEAR_MAX_AUTO_RECHECKS);
    expect(t.deps.getStatus).not.toHaveBeenCalled();
  });

  it('does not recheck once the bridge has moved past the deposit step', async () => {
    const t = harness(setDepositTimedOut(swapState({ status: 'SUCCESS' }), true, 0), {
      maxTicks: 5,
    });
    t.h.state = { ...t.h.state, step: 'building_transaction' };
    await t.run();
    expect(t.deps.recheckDeposit).not.toHaveBeenCalled();
    expect(t.ticks()).toBe(0);
  });

  it('stops, without rechecking, when the deposit address changes mid-request', async () => {
    const t = harness(setDepositTimedOut(swapState(), true, 0), { maxTicks: 5 });
    t.deps.getStatus = vi.fn(async () => {
      t.h.state = { ...t.h.state, depositAddress: 'XnewAddressxxxxxxxxxxxxxxxxxxxxxxx' };
      return 'SUCCESS' as const;
    });
    await t.run();
    expect(t.deps.setState).not.toHaveBeenCalled();
    expect(t.deps.recheckDeposit).not.toHaveBeenCalled();
    expect(t.ticks()).toBe(0);
  });

  it('stops when the user leaves the deposit step between polls', async () => {
    const t = harness(swapState(), {
      onTick: (tick, h) => { if (tick === 2) h.state = { ...h.state, step: 'init' }; },
      maxTicks: 10,
    });
    await t.run();
    expect(t.deps.getStatus).toHaveBeenCalledTimes(2);
  });

  it.each(['REFUNDED', 'FAILED'] as const)('stops polling once the swap is %s', async (status) => {
    const t = harness(swapState(), { statuses: [status], maxTicks: 10 });
    await t.run();
    expect(t.h.state.nearIntents!.swap!.status).toBe(status);
    expect(t.deps.getStatus).toHaveBeenCalledTimes(1);
    expect(t.ticks()).toBe(0);
  });

  it('records a failed status check and keeps polling', async () => {
    const t = harness(swapState(), { statuses: [new Error('timed out'), 'PROCESSING'], maxTicks: 2 });
    await t.run();
    expect(t.deps.getStatus).toHaveBeenCalledTimes(2);
    expect(t.h.state.nearIntents!.swap).toMatchObject({ status: 'PROCESSING', statusError: undefined });
  });

  it.each(['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT'] as const)(
    're-renders once at the payment cutoff for %s, then gives up after the grace period',
    async (status) => {
      const deadline = Date.parse(SWAP.deadline);
      let clock = deadline - 20 * 60 * 1000; // before the 15 min cutoff
      const t = harness(swapState({ status }), {
        statuses: [status],
        now: () => clock,
        onTick: () => { clock += 10 * 60 * 1000; },
        maxTicks: 50,
      });
      await t.run();
      // Exactly one forced re-render (the status never changed).
      expect(t.deps.setState).toHaveBeenCalledTimes(1);
      expect(clock).toBeGreaterThan(deadline + NEAR_EXPIRED_POLL_GRACE_MS);
      expect(t.ticks()).toBeLessThan(50);
    }
  );
});

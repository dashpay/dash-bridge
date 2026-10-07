import { describe, it, expect } from 'vitest';

import {
  createInitialState,
  setDepositTimedOut,
  setKeyPairs,
  toggleNearIntentsPanel,
  setNearIntentsTokensLoading,
  setNearIntentsTokens,
  setNearIntentsError,
  setNearIntentsOriginAsset,
  setNearIntentsAmountInput,
  setNearIntentsQuoting,
  setNearIntentsQuote,
  setNearIntentsSwap,
  setNearSwapStatus,
  clearNearIntentsSwap,
  shouldRecheckAfterNearSwap,
} from './state.js';
import type { BridgeState, NearIntentsSwap } from '../types.js';
import type { NearIntentsQuote, NearIntentsToken } from '../api/near-intents.js';

const USDC: NearIntentsToken = {
  assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  symbol: 'USDC',
  blockchain: 'eth',
  decimals: 6,
};
const SOL: NearIntentsToken = { assetId: 'nep141:sol.omft.near', symbol: 'SOL', blockchain: 'sol', decimals: 9 };
const QUOTE: NearIntentsQuote = {
  originAssetId: USDC.assetId,
  amountIn: '2680000',
  amountOut: '5000000',
  deadline: '2026-10-07T18:00:00.000Z',
};
const SWAP: NearIntentsSwap = {
  depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8',
  recipient: 'XanAvE5GMB8CsPH78B9moJq9viEVKvCS4f',
  refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D',
  originAssetId: USDC.assetId,
  symbol: 'USDC',
  blockchain: 'eth',
  decimals: 6,
  amountIn: '2680000',
  amountOut: '5000000',
  deadline: '2026-10-07T18:00:00.000Z',
  status: 'PENDING_DEPOSIT',
};

function depositState(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    ...createInitialState('mainnet'),
    step: 'detecting_deposit',
    depositAddress: SWAP.recipient,
    ...overrides,
  };
}

describe('NEAR Intents state', () => {
  it('opens with a default amount of 0.05 DASH, or the minimum if higher', () => {
    expect(toggleNearIntentsPanel(depositState()).nearIntents).toMatchObject({ open: true, amountInput: '0.05' });
    expect(toggleNearIntentsPanel(depositState({ minimumDeposit: 123_000_000 })).nearIntents!.amountInput).toBe('1.23');
    expect(toggleNearIntentsPanel(toggleNearIntentsPanel(depositState())).nearIntents!.open).toBe(false);
  });

  it('preselects USDC on Ethereum and keeps an existing choice when tokens reload', () => {
    let state = setNearIntentsTokensLoading(toggleNearIntentsPanel(depositState()));
    expect(state.nearIntents!.busy).toBe('tokens');
    state = setNearIntentsTokens(state, [SOL, USDC]);
    expect(state.nearIntents).toMatchObject({ busy: undefined, originAssetId: USDC.assetId });
    state = setNearIntentsOriginAsset(state, SOL.assetId);
    expect(setNearIntentsTokens(state, [SOL, USDC]).nearIntents!.originAssetId).toBe(SOL.assetId);
  });

  it('drops a priced quote when an input changes', () => {
    let state = setNearIntentsQuoting(toggleNearIntentsPanel(depositState()));
    expect(state.nearIntents!.busy).toBe('quote');
    state = setNearIntentsQuote(state, QUOTE);
    expect(state.nearIntents).toMatchObject({ busy: undefined, quote: QUOTE });
    expect(setNearIntentsAmountInput(state, '0.1').nearIntents!.quote).toBeUndefined();
    expect(setNearIntentsOriginAsset(state, SOL.assetId).nearIntents!.quote).toBeUndefined();
  });

  it('records errors and clears the busy flag', () => {
    const state = setNearIntentsError(setNearIntentsQuoting(depositState()), 'No liquidity');
    expect(state.nearIntents).toMatchObject({ busy: undefined, error: 'No liquidity' });
  });

  it('tracks status only for the swap it belongs to', () => {
    const state = setNearIntentsSwap(setNearIntentsQuote(depositState(), QUOTE), SWAP);
    expect(state.nearIntents!.quote).toBeUndefined();

    const processing = setNearSwapStatus(state, SWAP.depositAddress, { status: 'PROCESSING' });
    expect(processing.nearIntents!.swap!.status).toBe('PROCESSING');

    const failedPoll = setNearSwapStatus(processing, SWAP.depositAddress, { statusError: 'timed out' });
    expect(failedPoll.nearIntents!.swap).toMatchObject({ status: 'PROCESSING', statusError: 'timed out' });
    expect(setNearSwapStatus(failedPoll, SWAP.depositAddress, { status: 'SUCCESS' }).nearIntents!.swap!.statusError).toBeUndefined();

    expect(setNearSwapStatus(state, 'other-address', { status: 'SUCCESS' })).toBe(state);
    expect(setNearSwapStatus(clearNearIntentsSwap(state), SWAP.depositAddress, { status: 'SUCCESS' }).nearIntents!.swap).toBeUndefined();
  });

  it('survives the deposit timeout but not a new deposit address', () => {
    const state = setNearIntentsSwap(depositState(), SWAP);
    const timedOut = setDepositTimedOut(state, true, 0);
    expect(timedOut.nearIntents!.swap).toEqual(SWAP);

    const keyPair = { privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) };
    expect(setKeyPairs(state, keyPair, 'XnewAddress').nearIntents).toBeUndefined();
  });

  it('asks for a recheck after delivery only once the deposit poll has timed out', () => {
    const state = setNearIntentsSwap(depositState(), { ...SWAP, status: 'SUCCESS' });
    expect(shouldRecheckAfterNearSwap(state)).toBe(false);
    expect(shouldRecheckAfterNearSwap(setDepositTimedOut(state, true, 0))).toBe(true);
    expect(shouldRecheckAfterNearSwap({ ...setDepositTimedOut(state, true, 0), step: 'building_transaction' })).toBe(false);
  });
});

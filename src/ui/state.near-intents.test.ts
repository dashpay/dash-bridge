import { describe, it, expect } from 'vitest';

import {
  createInitialState,
  setDepositTimedOut,
  setKeyPairs,
  setNearIntentsTabOpen,
  setNearIntentsTokensLoading,
  setNearIntentsTokens,
  setNearIntentsError,
  setNearIntentsOriginAsset,
  setNearIntentsAmount,
  setNearIntentsPickerOpen,
  setNearIntentsRefundAddress,
  setNearIntentsRefundError,
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
  swapType: 'EXACT_OUTPUT',
  amountIn: '2680000',
  amountOut: '5000000',
  deadline: '2026-10-07T18:00:00.000Z',
  status: 'PENDING_DEPOSIT',
};
const open = (state: BridgeState) => setNearIntentsTabOpen(state, true);

function depositState(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    ...createInitialState('mainnet'),
    step: 'detecting_deposit',
    depositAddress: SWAP.recipient,
    ...overrides,
  };
}

describe('NEAR Intents state', () => {
  it('opens with 0.05 DASH to receive, or the minimum if higher', () => {
    expect(open(depositState()).nearIntents).toMatchObject({ open: true, amountSide: 'out', amountInput: '0.05' });
    expect(open(depositState({ minimumDeposit: 123_000_000 })).nearIntents!.amountInput).toBe('1.23');
    expect(setNearIntentsTabOpen(open(depositState()), false).nearIntents!.open).toBe(false);
  });

  it('closes the picker when switching tabs or choosing an asset', () => {
    const picking = setNearIntentsPickerOpen(open(depositState()), true);
    expect(picking.nearIntents!.pickerOpen).toBe(true);
    expect(setNearIntentsTabOpen(picking, false).nearIntents!.pickerOpen).toBe(false);
    expect(setNearIntentsOriginAsset(picking, SOL.assetId).nearIntents).toMatchObject({ pickerOpen: false, assetFilter: '' });
  });

  it('keeps the DASH amount when the asset changes under a typed pay amount', () => {
    let state = setNearIntentsAmount(setNearIntentsTokens(open(depositState()), [USDC, SOL]), 'in', '20');
    state = setNearIntentsQuote(state, { ...QUOTE, amountIn: '20000000', amountOut: '39400815' });
    expect(setNearIntentsOriginAsset(state, SOL.assetId).nearIntents).toMatchObject({ amountSide: 'out', amountInput: '0.39400815', quote: undefined });
    // Without a quote, fall back to the default DASH amount.
    const unquoted = setNearIntentsAmount(state, 'in', '25');
    expect(setNearIntentsOriginAsset(unquoted, SOL.assetId).nearIntents).toMatchObject({ amountSide: 'out', amountInput: '0.05' });
    // A typed DASH amount is kept as is.
    const typedOut = setNearIntentsAmount(state, 'out', '0.2');
    expect(setNearIntentsOriginAsset(typedOut, SOL.assetId).nearIntents).toMatchObject({ amountSide: 'out', amountInput: '0.2' });
  });

  it('keeps the live quote while the refund address is typed, and clears its error', () => {
    let state = setNearIntentsQuote(open(depositState()), QUOTE);
    state = setNearIntentsRefundError(state, 'Enter an address');
    state = setNearIntentsRefundAddress(state, '0xabc');
    expect(state.nearIntents).toMatchObject({ quote: QUOTE, refundAddress: '0xabc', refundError: undefined });
  });

  it('preselects USDC on Ethereum and keeps an existing choice when tokens reload', () => {
    let state = setNearIntentsTokensLoading(open(depositState()));
    expect(state.nearIntents!.busy).toBe('tokens');
    state = setNearIntentsTokens(state, [SOL, USDC]);
    expect(state.nearIntents).toMatchObject({ busy: undefined, originAssetId: USDC.assetId });
    state = setNearIntentsOriginAsset(state, SOL.assetId);
    expect(setNearIntentsTokens(state, [SOL, USDC]).nearIntents!.originAssetId).toBe(SOL.assetId);
  });

  it('never preselects DASH or another Dash-chain token as the source', () => {
    const dash = { assetId: 'nep141:dash.omft.near', symbol: 'DASH', blockchain: 'dash', decimals: 8 };
    const dashOther = { assetId: 'nep141:x-dash.omft.near', symbol: 'XD', blockchain: 'dash', decimals: 8 };
    const state = setNearIntentsTokens(open(depositState()), [dash, dashOther, SOL]);
    expect(state.nearIntents!.originAssetId).toBe(SOL.assetId);
    // An earlier DASH selection isn't kept either.
    const stale = setNearIntentsOriginAsset(state, dash.assetId);
    expect(setNearIntentsTokens(stale, [dash, SOL]).nearIntents!.originAssetId).toBe(SOL.assetId);
  });

  it('drops a priced quote when an input changes', () => {
    let state = setNearIntentsQuoting(open(depositState()));
    expect(state.nearIntents!.busy).toBe('quote');
    state = setNearIntentsQuote(state, QUOTE);
    expect(state.nearIntents).toMatchObject({ busy: undefined, quote: QUOTE });
    expect(setNearIntentsAmount(state, 'out', '0.1').nearIntents!.quote).toBeUndefined();
    expect(setNearIntentsAmount(state, 'in', '5').nearIntents).toMatchObject({ amountSide: 'in', quote: undefined });
    expect(setNearIntentsOriginAsset(state, SOL.assetId).nearIntents!.quote).toBeUndefined();
  });

  it('records errors and clears the busy flag', () => {
    const state = setNearIntentsError(setNearIntentsQuoting(depositState()), 'No liquidity');
    expect(state.nearIntents).toMatchObject({ busy: undefined, error: 'No liquidity' });
  });

  it('offers the minimum with a "too small" error until the amount changes', () => {
    const state = setNearIntentsError(open(depositState()), 'Too small', '0.107');
    expect(state.nearIntents!.minimumInput).toBe('0.107');
    expect(setNearIntentsAmount(state, 'out', '0.107').nearIntents).toMatchObject({ error: undefined, minimumInput: undefined });
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

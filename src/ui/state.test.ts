import { describe, it, expect } from 'vitest';

import { ErrorCodes, createInitialState, getStepDescription, setError } from './state.js';
import type { BridgeState } from '../types.js';

function baseState(): BridgeState {
  return createInitialState('testnet');
}

describe('setError chainlockFallbackAvailable gating', () => {
  it('enables the fallback on ISLOCK error when we have a txid', () => {
    const state: BridgeState = { ...baseState(), step: 'waiting_islock', txid: 'abc' };
    const result = setError(state, new Error('timeout'), ErrorCodes.ISLOCK);
    expect(result.chainlockFallbackAvailable).toBe(true);
    expect(result.step).toBe('error');
    expect(result.errorCode).toBe(ErrorCodes.ISLOCK);
  });

  it('does NOT enable the fallback on ISLOCK without a txid', () => {
    const state: BridgeState = { ...baseState(), step: 'waiting_islock' };
    const result = setError(state, new Error('timeout'), ErrorCodes.ISLOCK);
    expect(result.chainlockFallbackAvailable).toBe(false);
  });

  it('enables the fallback on REGISTER if we still have signedTxBytes + txid', () => {
    const state: BridgeState = {
      ...baseState(),
      step: 'registering_identity',
      txid: 'abc',
      signedTxBytes: new Uint8Array([0]),
    };
    const result = setError(state, new Error('platform reject'), ErrorCodes.REGISTER);
    expect(result.chainlockFallbackAvailable).toBe(true);
  });

  it('does NOT enable the fallback on REGISTER if signedTxBytes is missing', () => {
    const state: BridgeState = {
      ...baseState(),
      step: 'registering_identity',
      txid: 'abc',
    };
    const result = setError(state, new Error('platform reject'), ErrorCodes.REGISTER);
    expect(result.chainlockFallbackAvailable).toBe(false);
  });

  it('never enables the fallback for unrelated error codes', () => {
    const state: BridgeState = {
      ...baseState(),
      step: 'broadcasting',
      txid: 'abc',
      signedTxBytes: new Uint8Array([0]),
    };
    const result = setError(state, new Error('broadcast fail'), ErrorCodes.BROADCAST);
    expect(result.chainlockFallbackAvailable).toBe(false);
  });
});

describe('step descriptions', () => {
  it('uses explicit Dash Platform preparation copy for the key-generation step', () => {
    expect(getStepDescription('generating_keys')).toBe('Preparing Dash Platform...');
  });
});

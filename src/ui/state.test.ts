import { describe, it, expect } from 'vitest';

import {
  ErrorCodes,
  createInitialState,
  getStepDescription,
  setError,
  setIdentityRegistered,
  isChainlockFallbackCancelled,
  setMode,
  setWithdrawIdentityFetching,
  setWithdrawIdentityFetched,
  setWithdrawKeyValidated,
  setWithdrawKeyValidationError,
  setWithdrawAmountError,
  setWithdrawAddress,
  setWithdrawSubmitting,
  setWithdrawSubmitted,
  setWithdrawSubmitError,
  setWithdrawOutcomeUnknown,
  setWithdrawOutcomeChecking,
  setWithdrawRetry,
  setWithdrawStatusUpdate,
  setWithdrawTrackingTimeout,
} from './state.js';
import type { BridgeState } from '../types.js';
import {
  AssetLockConsumedElsewhereError,
  IdentityRegistrationUnconfirmedError,
} from '../platform/identity-confirm.js';

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

  it('does NOT enable the fallback for an unconfirmed (already submitted) registration', () => {
    const state: BridgeState = {
      ...baseState(),
      step: 'registering_identity',
      txid: 'abc',
      signedTxBytes: new Uint8Array([0]),
    };
    const result = setError(state, new IdentityRegistrationUnconfirmedError('someId'));
    expect(result.errorCode).toBe(ErrorCodes.REGISTER);
    expect(result.chainlockFallbackAvailable).toBe(false);
  });

  it('does NOT enable the fallback when the asset lock was consumed elsewhere', () => {
    const state: BridgeState = {
      ...baseState(),
      step: 'registering_identity',
      txid: 'abc',
      signedTxBytes: new Uint8Array([0]),
    };
    const result = setError(state, new AssetLockConsumedElsewhereError('someId'));
    expect(result.chainlockFallbackAvailable).toBe(false);
    expect(result.unconfirmedIdentityId).toBeUndefined();
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

describe('unconfirmed identity registration', () => {
  it('keeps the derived identity ID across later errors without marking it complete', () => {
    const registering: BridgeState = { ...baseState(), step: 'registering_identity' };
    const unconfirmed = setError(registering, new IdentityRegistrationUnconfirmedError('someId'));
    expect(unconfirmed.unconfirmedIdentityId).toBe('someId');
    expect(unconfirmed.identityId).toBeUndefined();

    const laterError = setError({ ...unconfirmed, step: 'registering_identity' }, new Error('network down'));
    expect(laterError.unconfirmedIdentityId).toBe('someId');

    const registered = setIdentityRegistered(laterError, 'someId');
    expect(registered.identityId).toBe('someId');
    expect(registered.unconfirmedIdentityId).toBeUndefined();
  });
});

describe('isChainlockFallbackCancelled', () => {
  it('treats an aborted signal as cancellation only before submission starts', () => {
    expect(isChainlockFallbackCancelled(true, false)).toBe(true);
    // The fallback aborts its own signal before submitting; errors after
    // that point must reach the error screen.
    expect(isChainlockFallbackCancelled(true, true)).toBe(false);
    expect(isChainlockFallbackCancelled(false, false)).toBe(false);
    expect(isChainlockFallbackCancelled(false, true)).toBe(false);
  });
});

describe('step descriptions', () => {
  it('uses explicit Dash Platform preparation copy for the key-generation step', () => {
    expect(getStepDescription('generating_keys')).toBe('Preparing Dash Platform...');
  });
});

describe('withdraw mode state transitions', () => {
  it('setMode withdraw enters withdraw_enter_identity with cleared fields', () => {
    const dirty: BridgeState = {
      ...baseState(),
      withdrawPrivateKeyWif: 'someWif',
      withdrawToAddress: 'yAddr',
      withdrawAmountCredits: 5n,
      withdrawStatus: 2,
    };
    const result = setMode(dirty, 'withdraw');
    expect(result.step).toBe('withdraw_enter_identity');
    expect(result.mode).toBe('withdraw');
    expect(result.withdrawPrivateKeyWif).toBeUndefined();
    expect(result.withdrawToAddress).toBeUndefined();
    expect(result.withdrawAmountCredits).toBeUndefined();
    expect(result.withdrawStatus).toBeUndefined();
  });

  it('switching to another mode clears withdraw-sensitive fields', () => {
    const state: BridgeState = {
      ...baseState(),
      mode: 'withdraw',
      withdrawPrivateKeyWif: 'someWif',
      withdrawToAddress: 'yAddr',
      withdrawAmountCredits: 5n,
    };
    const result = setMode(state, 'topup');
    expect(result.withdrawPrivateKeyWif).toBeUndefined();
    expect(result.withdrawToAddress).toBeUndefined();
    expect(result.withdrawAmountCredits).toBeUndefined();
  });

  it('identity fetch success advances to configure with keys and balance', () => {
    const fetching = setWithdrawIdentityFetching(baseState(), 'someIdentityId');
    expect(fetching.withdrawIdentityFetching).toBe(true);
    expect(fetching.targetIdentityId).toBe('someIdentityId');
    const fetched = setWithdrawIdentityFetched(fetching, [], 123456n);
    expect(fetched.step).toBe('withdraw_configure');
    expect(fetched.withdrawIdentityFetching).toBe(false);
    expect(fetched.withdrawBalance).toBe(123456n);
  });

  it('submit success moves to tracking with QUEUED status', () => {
    const state = setWithdrawSubmitting(baseState());
    expect(state.step).toBe('withdraw_submitting');
    const submitted = setWithdrawSubmitted(state, 42n);
    expect(submitted.step).toBe('withdraw_tracking');
    expect(submitted.withdrawStatus).toBe(0);
    expect(submitted.withdrawResult).toEqual({ success: true, remainingBalance: 42n });
  });

  it('ambiguous timeout enters tracking without a remaining balance, still a success', () => {
    const submitted = setWithdrawSubmitted(setWithdrawSubmitting(baseState()));
    expect(submitted.step).toBe('withdraw_tracking');
    expect(submitted.withdrawStatus).toBe(0);
    expect(submitted.withdrawResult).toEqual({ success: true, remainingBalance: undefined });
  });

  it('submit error terminates with a failed result', () => {
    const result = setWithdrawSubmitError(setWithdrawSubmitting(baseState()), 'boom');
    expect(result.step).toBe('withdraw_complete');
    expect(result.withdrawResult).toEqual({ success: false, error: 'boom' });
  });

  it('unknown outcome is a non-retryable failure that keeps the lookup window', () => {
    const unknown = setWithdrawOutcomeUnknown(setWithdrawSubmitting(baseState()), 'boom', 1234);
    expect(unknown.step).toBe('withdraw_complete');
    expect(unknown.withdrawResult).toEqual({ success: false, error: 'boom' });
    expect(unknown.withdrawOutcomeUnknown).toEqual({ sinceMs: 1234, checking: false });
    // Retry is refused while the outcome is unknown
    expect(setWithdrawRetry(unknown)).toBe(unknown);
  });

  it('Check Again marks the unknown outcome as checking', () => {
    const unknown = setWithdrawOutcomeUnknown(baseState(), 'boom', 1234);
    expect(setWithdrawOutcomeChecking(unknown).withdrawOutcomeUnknown).toEqual({ sinceMs: 1234, checking: true });
    // No-op without an unknown outcome
    const plain = baseState();
    expect(setWithdrawOutcomeChecking(plain)).toBe(plain);
  });

  it('resolving an unknown outcome clears it: found tracks, not found becomes retryable', () => {
    const checking = setWithdrawOutcomeChecking(setWithdrawOutcomeUnknown(baseState(), 'boom', 1234));

    const found = setWithdrawSubmitted(checking);
    expect(found.step).toBe('withdraw_tracking');
    expect(found.withdrawOutcomeUnknown).toBeUndefined();

    const notFound = setWithdrawSubmitError(checking, 'boom');
    expect(notFound.withdrawOutcomeUnknown).toBeUndefined();
    expect(notFound.withdrawResult).toEqual({ success: false, error: 'boom' });
    expect(setWithdrawRetry(notFound).step).toBe('withdraw_configure');
  });

  it('re-entering withdraw mode or resubmitting clears an unknown outcome', () => {
    const unknown = setWithdrawOutcomeUnknown(baseState(), 'boom', 1234);
    expect(setMode(unknown, 'withdraw').withdrawOutcomeUnknown).toBeUndefined();
    expect(setWithdrawSubmitting(unknown).withdrawOutcomeUnknown).toBeUndefined();
  });

  it('status updates stay in tracking until terminal', () => {
    let state = setWithdrawSubmitted(setWithdrawSubmitting(baseState()), 42n);
    state = setWithdrawStatusUpdate(state, 1);
    expect(state.step).toBe('withdraw_tracking');
    state = setWithdrawStatusUpdate(state, 2);
    expect(state.step).toBe('withdraw_tracking');
    state = setWithdrawStatusUpdate(state, 3);
    expect(state.step).toBe('withdraw_complete');
    expect(state.withdrawStatus).toBe(3);
  });

  it('EXPIRED status is terminal', () => {
    const state = setWithdrawStatusUpdate(
      setWithdrawSubmitted(setWithdrawSubmitting(baseState()), 42n),
      4
    );
    expect(state.step).toBe('withdraw_complete');
  });

  it('tracking timeout completes without clearing the success result', () => {
    const submitted = setWithdrawSubmitted(setWithdrawSubmitting(baseState()), 42n);
    const timedOut = setWithdrawTrackingTimeout(submitted, 'still queued');
    expect(timedOut.step).toBe('withdraw_complete');
    expect(timedOut.withdrawResult?.success).toBe(true);
    expect(timedOut.withdrawStatusError).toBe('still queued');
  });

  it('key validation error clears validated key material', () => {
    const validated = setWithdrawKeyValidated(baseState(), 3, 3, 1, 'wif');
    expect(validated.withdrawSigningKeyInfo).toEqual({ keyId: 3, purpose: 3, securityLevel: 1 });
    const errored = setWithdrawKeyValidationError(validated, 'not a transfer key');
    expect(errored.withdrawSigningKeyInfo).toBeUndefined();
    expect(errored.withdrawPrivateKeyWif).toBeUndefined();
    expect(errored.withdrawKeyValidationError).toBe('not a transfer key');
  });

  it('amount/address errors preserve raw input', () => {
    const badAmount = setWithdrawAmountError(baseState(), '0.0000001', 'too small');
    expect(badAmount.withdrawAmountInput).toBe('0.0000001');
    expect(badAmount.withdrawAmountCredits).toBeUndefined();
    const badAddress = setWithdrawAddress(baseState(), 'Xoops', 'wrong network');
    expect(badAddress.withdrawToAddress).toBe('Xoops');
    expect(badAddress.withdrawAddressError).toBe('wrong network');
    const goodAddress = setWithdrawAddress(badAddress, 'yGoodAddr');
    expect(goodAddress.withdrawToAddress).toBe('yGoodAddr');
    expect(goodAddress.withdrawAddressError).toBeUndefined();
  });
});

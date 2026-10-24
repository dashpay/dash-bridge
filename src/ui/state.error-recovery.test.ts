import { describe, it, expect } from 'vitest';

import { ErrorCodes, createInitialState, getErrorRecovery, setError } from './state.js';
import type { AssetLockProofData, BridgeState } from '../types.js';
import { ChunkLoadError } from '../platform/chunk-loader.js';
import {
  AssetLockConsumedElsewhereError,
  IdentityRegistrationUnconfirmedError,
} from '../platform/identity-confirm.js';

const importFailure = () => new ChunkLoadError('evo-sdk', 3, new TypeError('Importing a module script failed.'));

const instantProof: AssetLockProofData = {
  type: 'instant',
  transactionBytes: new Uint8Array([1]),
  instantLockBytes: new Uint8Array([2]),
  outputIndex: 0,
};

/** Create flow right after the InstantSend lock arrived (as setInstantLockReceived leaves it). */
function lockReceived(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    ...createInitialState('testnet'),
    step: 'registering_identity',
    depositAddress: 'yAddr',
    txid: 'ab'.repeat(32),
    signedTxBytes: new Uint8Array([0]),
    assetLockKeyPair: { privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) },
    instantLockBytes: new Uint8Array([2]),
    assetLockProof: instantProof,
    ...overrides,
  };
}

describe('getErrorRecovery after the InstantSend lock arrived', () => {
  it('reports the lock as received and offers both a retry and the chain lock proof when the SDK chunk failed', () => {
    const errored = setError(lockReceived(), importFailure());
    expect(errored.errorCode).toBe(ErrorCodes.REGISTER);
    expect(errored.chainlockFallbackAvailable).toBe(true);
    expect(getErrorRecovery(errored)).toEqual({
      lockReceived: true,
      canRetrySubmission: true,
      reloadSafe: false,
      failedChunk: 'evo-sdk',
    });
  });

  it('offers a retry for every funding mode (top-up, send to address) with the proof in state', () => {
    for (const [mode, step, code] of [
      ['topup', 'topping_up', ErrorCodes.TOPUP],
      ['send_to_address', 'sending_to_address', ErrorCodes.SEND_ADDRESS],
    ] as const) {
      const errored = setError(lockReceived({ mode, step }), new Error('platform reject'));
      expect(errored.errorCode).toBe(code);
      expect(getErrorRecovery(errored)).toMatchObject({ lockReceived: true, canRetrySubmission: true });
    }
  });

  it('keeps offering a retry for an unconfirmed registration', () => {
    const errored = setError(lockReceived(), new IdentityRegistrationUnconfirmedError('someId'));
    expect(getErrorRecovery(errored).canRetrySubmission).toBe(true);
    expect(errored.chainlockFallbackAvailable).toBe(false);
  });

  it('offers no retry once the asset lock was consumed elsewhere', () => {
    const errored = setError(lockReceived(), new AssetLockConsumedElsewhereError('someId'));
    expect(getErrorRecovery(errored).canRetrySubmission).toBe(false);
  });

  it('offers no retry without the proof or the asset lock key', () => {
    expect(getErrorRecovery(setError(lockReceived({ assetLockProof: undefined }), importFailure())))
      .toMatchObject({ lockReceived: false, canRetrySubmission: false });
    expect(getErrorRecovery(setError(lockReceived({ assetLockKeyPair: undefined }), importFailure())))
      .toMatchObject({ lockReceived: true, canRetrySubmission: false });
  });

  it('does not call a chain proof an InstantSend lock', () => {
    const chainProof: AssetLockProofData = { type: 'chain', coreChainLockedHeight: 10, txid: 'ab'.repeat(32), vout: 0 };
    const errored = setError(lockReceived({ assetLockProof: chainProof }), new Error('platform reject'));
    expect(getErrorRecovery(errored)).toMatchObject({ lockReceived: false, canRetrySubmission: true });
  });
});

describe('getErrorRecovery for a missing InstantSend lock', () => {
  it('is not a received lock and has nothing to retry', () => {
    const waiting: BridgeState = { ...lockReceived(), step: 'waiting_islock', assetLockProof: undefined, instantLockBytes: undefined };
    const errored = setError(waiting, new Error('timeout'));
    expect(errored.errorCode).toBe(ErrorCodes.ISLOCK);
    expect(errored.chainlockFallbackAvailable).toBe(true);
    expect(getErrorRecovery(errored)).toMatchObject({ lockReceived: false, canRetrySubmission: false, reloadSafe: false });
  });
});

describe('component load failure while preparing a funding flow', () => {
  it('gets its own code and is safe to reload before any deposit address exists', () => {
    const preparing: BridgeState = { ...createInitialState('testnet'), step: 'generating_keys' };
    const errored = setError(preparing, importFailure());
    expect(errored.errorCode).toBe(ErrorCodes.COMPONENT_LOAD);
    expect(errored.chainlockFallbackAvailable).toBe(false);
    expect(getErrorRecovery(errored)).toEqual({
      lockReceived: false,
      canRetrySubmission: false,
      reloadSafe: true,
      failedChunk: 'evo-sdk',
    });
  });

  it('keeps the key generation code for other errors in that step', () => {
    const preparing: BridgeState = { ...createInitialState('testnet'), step: 'generating_keys' };
    expect(setError(preparing, new Error('boom')).errorCode).toBe(ErrorCodes.KEY_GEN);
  });

  it('is never "safe to reload" once a deposit address was shown', () => {
    const shown: BridgeState = { ...createInitialState('testnet'), step: 'generating_keys', depositAddress: 'yAddr' };
    const errored = setError(shown, importFailure());
    expect(errored.errorCode).toBe(ErrorCodes.KEY_GEN);
    expect(getErrorRecovery(errored).reloadSafe).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';

import {
  ErrorCodes,
  createInitialState,
  getStepDescription,
  setError,
  setMode,
  updateIdentityKey,
  updateManageNewKey,
} from './state.js';
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

describe('setMode("create") state path', () => {
  const initial = createInitialState('testnet');

  it('transitions to configure_keys with mnemonic and all 6 identity keys including ENCRYPTION and DECRYPTION', () => {
    const state = setMode(initial, 'create');

    expect(state.step).toBe('configure_keys');
    expect(state.mode).toBe('create');
    expect(state.mnemonic).toBeTruthy();
    expect(state.identityKeys).toHaveLength(6);

    const purposes = state.identityKeys.map((k) => k.purpose);
    expect(purposes).toContain('ENCRYPTION');
    expect(purposes).toContain('DECRYPTION');
  });
});

describe('updateIdentityKey security level coercion', () => {
  const state = setMode(createInitialState('testnet'), 'create');

  it('coerces DECRYPTION purpose to MEDIUM security level', () => {
    const decKey = state.identityKeys.find(k => k.purpose === 'DECRYPTION')!;
    const updated = updateIdentityKey(state, decKey.id, { securityLevel: 'CRITICAL' });
    const key = updated.identityKeys.find(k => k.id === decKey.id)!;
    expect(key.securityLevel).toBe('MEDIUM');
  });

  it('coerces ENCRYPTION purpose to MEDIUM security level', () => {
    const encKey = state.identityKeys.find(k => k.purpose === 'ENCRYPTION')!;
    const updated = updateIdentityKey(state, encKey.id, { securityLevel: 'HIGH' });
    const key = updated.identityKeys.find(k => k.id === encKey.id)!;
    expect(key.securityLevel).toBe('MEDIUM');
  });

  it('coerces security level when purpose is changed to DECRYPTION', () => {
    const authKey = state.identityKeys.find(k => k.purpose === 'AUTHENTICATION' && k.securityLevel === 'HIGH')!;
    const updated = updateIdentityKey(state, authKey.id, { purpose: 'DECRYPTION' });
    const key = updated.identityKeys.find(k => k.id === authKey.id)!;
    expect(key.purpose).toBe('DECRYPTION');
    expect(key.securityLevel).toBe('MEDIUM');
  });
});

describe('updateManageNewKey security level coercion', () => {
  it('coerces DECRYPTION purpose to MEDIUM security level', () => {
    const state: any = {
      manageKeysToAdd: [{
        tempId: 'test-1',
        purpose: 'DECRYPTION',
        securityLevel: 'CRITICAL',
        keyType: 'ECDSA_SECP256K1',
        name: 'Test',
      }],
    };
    const updated = updateManageNewKey(state, 'test-1', { securityLevel: 'HIGH' });
    expect(updated.manageKeysToAdd![0].securityLevel).toBe('MEDIUM');
  });

  it('coerces security level when purpose is changed to ENCRYPTION', () => {
    const state: any = {
      manageKeysToAdd: [{
        tempId: 'test-1',
        purpose: 'AUTHENTICATION',
        securityLevel: 'HIGH',
        keyType: 'ECDSA_SECP256K1',
        name: 'Test',
      }],
    };
    const updated = updateManageNewKey(state, 'test-1', { purpose: 'ENCRYPTION' });
    expect(updated.manageKeysToAdd![0].securityLevel).toBe('MEDIUM');
  });
});

describe('step descriptions', () => {
  it('uses explicit Dash Platform preparation copy for the key-generation step', () => {
    expect(getStepDescription('generating_keys')).toBe('Preparing Dash Platform...');
  });
});

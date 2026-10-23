import { describe, expect, it } from 'vitest';
import {
  addIdentityKey,
  createInitialState,
  regenerateAllIdentityKeys,
  removeIdentityKey,
  setMode,
  setNetwork,
  updateIdentityKey,
} from './state.js';
import { deriveIdentityKey } from '../crypto/hd.js';

describe('identity key derivation after removing a key', () => {
  const initial = () => setMode(createInitialState('testnet'), 'create');

  it('gives a newly added key a distinct derivation path and private key', () => {
    const state = addIdentityKey(removeIdentityKey(initial(), 1));
    expect(new Set(state.identityKeys.map((key) => key.derivationPath)).size).toBe(state.identityKeys.length);
    expect(new Set(state.identityKeys.map((key) => key.privateKeyHex)).size).toBe(state.identityKeys.length);
  });

  it('keeps the private key and derivation path when changing its data type', () => {
    const state = removeIdentityKey(initial(), 1);
    const original = state.identityKeys.find((key) => key.id === 2)!;
    const changed = updateIdentityKey(state, 2, { keyType: 'ECDSA_HASH160' }).identityKeys.find((key) => key.id === 2)!;
    expect(changed.privateKeyHex).toBe(original.privateKeyHex);
    expect(changed.derivationPath).toBe(original.derivationPath);
    expect(atob(changed.dataBase64)).toHaveLength(20);
  });

  it('re-derives the same keys when regenerating', () => {
    const state = removeIdentityKey(initial(), 1);
    const regenerated = regenerateAllIdentityKeys(state);
    expect(regenerated.identityKeys.map((key) => key.privateKeyHex)).toEqual(state.identityKeys.map((key) => key.privateKeyHex));
    expect(regenerated.identityKeys.map((key) => key.derivationPath)).toEqual(state.identityKeys.map((key) => key.derivationPath));
  });

  it('preserves each key index across network changes and a round trip', () => {
    const state = removeIdentityKey(initial(), 1);
    const mainnet = setNetwork(state, 'mainnet');
    for (const key of mainnet.identityKeys) {
      const expected = deriveIdentityKey(state.mnemonic!, key.id, 'mainnet');
      expect(key.privateKey).toEqual(expected.privateKey);
      expect(key.derivationPath).toBe(expected.derivationPath);
    }
    expect(setNetwork(mainnet, 'testnet').identityKeys).toEqual(state.identityKeys);
  });
});

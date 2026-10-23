import { describe, expect, it } from 'vitest';
import { findMatchingKeyIndex, getPublicKey } from './keys.js';
import { privateKeyToWif } from '../utils/wif.js';
import { MAINNET, TESTNET } from '../config.js';
import { hash160 } from './hash.js';
import { hexToBytes } from '../utils/hex.js';
import type { IdentityPublicKeyInfo } from '../types.js';

describe('findMatchingKeyIndex', () => {
  const privateKey = new Uint8Array(32).fill(1);
  const publicKey = getPublicKey(privateKey);
  const identityKey: IdentityPublicKeyInfo = {
    id: 3, type: 0, purpose: 3, securityLevel: 1, data: publicKey,
  };

  it.each([
    ['zero', new Uint8Array(32)],
    ['curve order', hexToBytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')],
    ['above curve order', new Uint8Array(32).fill(0xff)],
  ])('rejects a checksum-valid WIF with an invalid %s scalar without throwing', (_, scalar) => {
    const wif = privateKeyToWif(scalar, TESTNET);
    expect(findMatchingKeyIndex(wif, [identityKey], 'testnet')).toBeNull();
  });

  it('returns null for malformed WIFs and the wrong network', () => {
    expect(findMatchingKeyIndex('not-a-wif', [identityKey], 'testnet')).toBeNull();
    expect(findMatchingKeyIndex(privateKeyToWif(privateKey, MAINNET), [identityKey], 'testnet')).toBeNull();
  });

  it('still matches full and hashed public keys', () => {
    const wif = privateKeyToWif(privateKey, TESTNET);
    expect(findMatchingKeyIndex(wif, [identityKey], 'testnet')?.keyId).toBe(3);
    expect(findMatchingKeyIndex(wif, [{ ...identityKey, type: 2, data: hash160(publicKey) }], 'testnet')?.keyId).toBe(3);
  });
});

import { describe, it, expect } from 'vitest';
import { generateDefaultIdentityKeysHD, generateDefaultIdentityKeys } from './keys.js';
import { generateNewMnemonic } from './hd.js';

/**
 * Tests for identity key generation in the create flow.
 *
 * The create-identity path calls generateDefaultIdentityKeysHD() which must
 * produce all required keys including both ENCRYPTION and DECRYPTION.
 */
describe('generateDefaultIdentityKeysHD', () => {
  const network = 'testnet' as const;
  const mnemonic = generateNewMnemonic(128);

  it('produces the correct key layout for identity creation', () => {
    const keys = generateDefaultIdentityKeysHD(network, mnemonic);
    const layout = keys.map((k) => ({
      id: k.id,
      name: k.name,
      purpose: k.purpose,
      securityLevel: k.securityLevel,
      keyType: k.keyType,
    }));

    expect(layout).toEqual([
      { id: 0, name: 'Master', purpose: 'AUTHENTICATION', securityLevel: 'MASTER', keyType: 'ECDSA_SECP256K1' },
      { id: 1, name: 'High Auth', purpose: 'AUTHENTICATION', securityLevel: 'HIGH', keyType: 'ECDSA_SECP256K1' },
      { id: 2, name: 'Critical Auth', purpose: 'AUTHENTICATION', securityLevel: 'CRITICAL', keyType: 'ECDSA_SECP256K1' },
      { id: 3, name: 'Transfer', purpose: 'TRANSFER', securityLevel: 'CRITICAL', keyType: 'ECDSA_SECP256K1' },
      { id: 4, name: 'Encryption', purpose: 'ENCRYPTION', securityLevel: 'MEDIUM', keyType: 'ECDSA_SECP256K1' },
      { id: 5, name: 'Decryption', purpose: 'DECRYPTION', securityLevel: 'MEDIUM', keyType: 'ECDSA_SECP256K1' },
    ]);
  });

});

describe('generateDefaultIdentityKeys (deprecated)', () => {
  it('produces the same key layout as the HD variant', () => {
    const keys = generateDefaultIdentityKeys('testnet');
    expect(keys).toHaveLength(6);
    const purposes = keys.map((k) => k.purpose);
    expect(purposes).toContain('ENCRYPTION');
    expect(purposes).toContain('DECRYPTION');
  });
});

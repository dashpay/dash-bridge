import { describe, it, expect } from 'vitest';

import { validateCoreAddress, validatePlatformAddress } from './address.js';
import { bech32m } from '@scure/base';
import { base58CheckEncode } from '../utils/base58.js';
import { TESTNET, MAINNET } from '../config.js';

describe('validatePlatformAddress', () => {
  const encode = (bytes: Uint8Array, hrp = 'tdash') => bech32m.encode(hrp, bech32m.toWords(bytes));

  it('accepts SDK-generated P2PKH and P2SH fixtures on the correct network', () => {
    // Generated with evo-sdk 4.1.1 PlatformAddress.fromP2{pkh,sh}Hash(...).toBech32m().
    const fixtures = [
      ['tdash1kqqszqgpqyqszqgpqyqszqgpqyqszqgpqymtq8wv', TESTNET],
      ['tdash1sqqszqgpqyqszqgpqyqszqgpqyqszqgpqykswwxq', TESTNET],
      ['dash1kqqszqgpqyqszqgpqyqszqgpqyqszqgpqytvnelz', MAINNET],
      ['dash1sqqszqgpqyqszqgpqyqszqgpqyqszqgpqyxhashw', MAINNET],
    ] as const;
    for (const [address, network] of fixtures) {
      expect(validatePlatformAddress(address, network)).toBe(true);
      expect(validatePlatformAddress(address.toUpperCase(), network)).toBe(true);
      expect(validatePlatformAddress(address, network === TESTNET ? MAINNET : TESTNET)).toBe(false);
    }
  });

  it('rejects checksum-valid payloads with incorrect lengths', () => {
    for (const size of [0, 1, 20, 22, 32]) {
      const bytes = new Uint8Array(size).fill(0xb0);
      expect(validatePlatformAddress(encode(bytes), TESTNET)).toBe(false);
    }
  });

  it('rejects unknown wire types, including raw SDK enum values', () => {
    for (const type of [0, 1, 2, 0xff]) {
      expect(validatePlatformAddress(encode(new Uint8Array(21).fill(type)), TESTNET)).toBe(false);
    }
  });

  it('rejects a bad checksum and invalid byte padding', () => {
    expect(validatePlatformAddress('tdash1kqqszqgpqyqszqgpqyqszqgpqyqszqgpqymtq8wq', TESTNET)).toBe(false);
    expect(validatePlatformAddress(bech32m.encode('tdash', [1]), TESTNET)).toBe(false);
    expect(validatePlatformAddress('', TESTNET)).toBe(false);
  });
});

function makeAddress(prefix: number, fill = 0x42): string {
  const payload = new Uint8Array(21);
  payload[0] = prefix;
  payload.fill(fill, 1);
  return base58CheckEncode(payload);
}

describe('validateCoreAddress', () => {
  it('accepts a testnet P2PKH address', () => {
    const result = validateCoreAddress(makeAddress(TESTNET.addressPrefix), TESTNET);
    expect(result).toEqual({ valid: true, type: 'p2pkh' });
  });

  it('accepts a testnet P2SH address', () => {
    const result = validateCoreAddress(makeAddress(TESTNET.p2shPrefix), TESTNET);
    expect(result).toEqual({ valid: true, type: 'p2sh' });
  });

  it('accepts mainnet P2PKH and P2SH addresses on mainnet', () => {
    expect(validateCoreAddress(makeAddress(MAINNET.addressPrefix), MAINNET).valid).toBe(true);
    expect(validateCoreAddress(makeAddress(MAINNET.p2shPrefix), MAINNET).valid).toBe(true);
  });

  it('rejects a mainnet address on testnet with a wrong-network error', () => {
    const result = validateCoreAddress(makeAddress(MAINNET.addressPrefix), TESTNET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('wrong network');
  });

  it('rejects a bech32m platform address with a targeted error', () => {
    const result = validateCoreAddress(
      'tdash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      TESTNET
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Platform address');
  });

  it('rejects garbage and bad checksums', () => {
    expect(validateCoreAddress('not-an-address', TESTNET).valid).toBe(false);
    expect(validateCoreAddress('yYyYyYyYyYyYyYyYyYyYyYyYyYyYyYyYyY', TESTNET).valid).toBe(false);
    expect(validateCoreAddress('', TESTNET).valid).toBe(false);
  });

  it('rejects payloads that are not 21 bytes', () => {
    const short = base58CheckEncode(new Uint8Array([TESTNET.addressPrefix, 1, 2, 3]));
    const result = validateCoreAddress(short, TESTNET);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('length');
  });

  it('trims surrounding whitespace', () => {
    const addr = makeAddress(TESTNET.addressPrefix);
    expect(validateCoreAddress(`  ${addr}  `, TESTNET).valid).toBe(true);
  });
});

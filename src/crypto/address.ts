import { hash160 } from './hash.js';
import { base58CheckEncode, base58CheckDecode } from '../utils/base58.js';
import { concatBytes } from '../utils/hex.js';
import type { NetworkConfig } from '../config.js';
import { bech32m } from '@scure/base';

/** Validate the complete Platform address before asking the user to fund it. */
export function validatePlatformAddress(address: string, network: NetworkConfig): boolean {
  try {
    const { prefix, bytes } = bech32m.decodeToBytes(address.trim());
    // The bech32m wire types are 0xb0 (P2PKH) and 0x80 (P2SH), distinct
    // from the SDK's raw-address enum bytes (0 and 1).
    return prefix === network.platformHrp
      && bytes.length === 21
      && (bytes[0] === 0xb0 || bytes[0] === 0x80);
  } catch {
    return false;
  }
}

export interface CoreAddressValidation {
  valid: boolean;
  type?: 'p2pkh' | 'p2sh';
  error?: string;
}

/**
 * Validate a Dash Core (L1) base58check address for the given network.
 * Accepts P2PKH and P2SH addresses only — the two script types Platform
 * allows as credit-withdrawal destinations.
 */
export function validateCoreAddress(
  address: string,
  network: NetworkConfig
): CoreAddressValidation {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Enter a Dash address' };
  }
  if (trimmed.toLowerCase().startsWith('dash1') || trimmed.toLowerCase().startsWith('tdash1')) {
    return {
      valid: false,
      error: 'This looks like a Platform address. Enter a Dash Core address (starts with X on mainnet, y on testnet).',
    };
  }
  let payload: Uint8Array;
  try {
    payload = base58CheckDecode(trimmed);
  } catch {
    return { valid: false, error: 'Invalid address (bad characters or checksum)' };
  }
  if (payload.length !== 21) {
    return { valid: false, error: 'Invalid address (unexpected length)' };
  }
  const version = payload[0];
  if (version === network.addressPrefix) {
    return { valid: true, type: 'p2pkh' };
  }
  if (version === network.p2shPrefix) {
    return { valid: true, type: 'p2sh' };
  }
  return {
    valid: false,
    error: `This address is not valid for ${network.name} (wrong network prefix)`,
  };
}

/**
 * Generate P2PKH address from public key
 */
export function publicKeyToAddress(
  publicKey: Uint8Array,
  network: NetworkConfig
): string {
  const pubKeyHash = hash160(publicKey);
  const versionedHash = concatBytes(
    new Uint8Array([network.addressPrefix]),
    pubKeyHash
  );
  return base58CheckEncode(versionedHash);
}

/**
 * Get pubkey hash from public key
 */
export function publicKeyToHash(publicKey: Uint8Array): Uint8Array {
  return hash160(publicKey);
}

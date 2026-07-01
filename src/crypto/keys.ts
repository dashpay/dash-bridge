import * as secp256k1 from '@noble/secp256k1';
import { randomBytes } from '@noble/hashes/utils';
import type { KeyPair, IdentityKeyConfig, KeyType, KeyPurpose, SecurityLevel, IdentityPublicKeyInfo } from '../types.js';
import { hash160 } from './hash.js';
import { bytesToHex } from '../utils/hex.js';
import { privateKeyToWif, wifToPrivateKey } from '../utils/wif.js';
import { getNetwork } from '../config.js';
import { deriveIdentityKey as deriveIdentityKeyHD } from './hd.js';

/**
 * Generate a new secp256k1 key pair
 */
export function generateKeyPair(): KeyPair {
  const privateKey = randomBytes(32);
  const publicKey = secp256k1.getPublicKey(privateKey, true); // compressed (33 bytes)
  return { privateKey, publicKey };
}

/**
 * Get compressed public key from private key
 */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true);
}

/**
 * Validate a private key
 */
export function isValidPrivateKey(privateKey: Uint8Array): boolean {
  try {
    secp256k1.getPublicKey(privateKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert bytes to base64
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Get the data bytes for SDK based on key type
 * - ECDSA_SECP256K1: full 33-byte compressed public key
 * - ECDSA_HASH160: 20-byte hash160 of the public key
 */
function getKeyDataBytes(publicKey: Uint8Array, keyType: KeyType): Uint8Array {
  if (keyType === 'ECDSA_HASH160') {
    return hash160(publicKey);
  }
  return publicKey;
}

/**
 * Generate a configured identity key
 */
export function generateIdentityKey(
  id: number,
  name: string,
  keyType: KeyType,
  purpose: KeyPurpose,
  securityLevel: SecurityLevel,
  network: string
): IdentityKeyConfig {
  const keyPair = generateKeyPair();
  const networkConfig = getNetwork(network);
  const dataBytes = getKeyDataBytes(keyPair.publicKey, keyType);

  return {
    id,
    name,
    keyType,
    purpose,
    securityLevel,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    privateKeyHex: bytesToHex(keyPair.privateKey),
    privateKeyWif: privateKeyToWif(keyPair.privateKey, networkConfig),
    publicKeyHex: bytesToHex(keyPair.publicKey),
    dataBase64: bytesToBase64(dataBytes),
  };
}

/**
 * Regenerate a key with new cryptographic material but same config
 */
export function regenerateIdentityKey(
  existing: IdentityKeyConfig,
  network: string
): IdentityKeyConfig {
  return generateIdentityKey(
    existing.id,
    existing.name,
    existing.keyType,
    existing.purpose,
    existing.securityLevel,
    network
  );
}

/**
 * Update key type and regenerate data (keeps same private key)
 */
export function updateKeyType(
  existing: IdentityKeyConfig,
  newKeyType: KeyType,
  network: string
): IdentityKeyConfig {
  const networkConfig = getNetwork(network);
  const dataBytes = getKeyDataBytes(existing.publicKey, newKeyType);

  return {
    ...existing,
    keyType: newKeyType,
    privateKeyWif: privateKeyToWif(existing.privateKey, networkConfig),
    dataBase64: bytesToBase64(dataBytes),
  };
}

/**
 * Generate default identity keys (6 keys)
 * @deprecated Use generateDefaultIdentityKeysHD for HD derivation
 */
export function generateDefaultIdentityKeys(
  network: string
): IdentityKeyConfig[] {
  return [
    generateIdentityKey(0, 'Master', 'ECDSA_SECP256K1', 'AUTHENTICATION', 'MASTER', network),
    generateIdentityKey(1, 'High Auth', 'ECDSA_SECP256K1', 'AUTHENTICATION', 'HIGH', network),
    generateIdentityKey(2, 'Critical Auth', 'ECDSA_SECP256K1', 'AUTHENTICATION', 'CRITICAL', network),
    generateIdentityKey(3, 'Transfer', 'ECDSA_SECP256K1', 'TRANSFER', 'CRITICAL', network),
    generateIdentityKey(4, 'Encryption', 'ECDSA_SECP256K1', 'ENCRYPTION', 'MEDIUM', network),
    generateIdentityKey(5, 'Decryption', 'ECDSA_SECP256K1', 'DECRYPTION', 'MEDIUM', network),
  ];
}

/**
 * Create an IdentityKeyConfig from a provided key pair
 */
export function createIdentityKeyFromKeyPair(
  id: number,
  name: string,
  keyType: KeyType,
  purpose: KeyPurpose,
  securityLevel: SecurityLevel,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  network: string,
  derivationPath?: string
): IdentityKeyConfig {
  const networkConfig = getNetwork(network);
  const dataBytes = getKeyDataBytes(publicKey, keyType);

  return {
    id,
    name,
    keyType,
    purpose,
    securityLevel,
    privateKey,
    publicKey,
    privateKeyHex: bytesToHex(privateKey),
    privateKeyWif: privateKeyToWif(privateKey, networkConfig),
    publicKeyHex: bytesToHex(publicKey),
    dataBase64: bytesToBase64(dataBytes),
    derivationPath,
  };
}

/**
 * Generate a configured identity key using HD derivation
 */
export function generateIdentityKeyFromMnemonic(
  id: number,
  name: string,
  keyType: KeyType,
  purpose: KeyPurpose,
  securityLevel: SecurityLevel,
  network: string,
  mnemonic: string,
  keyIndex: number
): IdentityKeyConfig {
  const { privateKey, publicKey, derivationPath } = deriveIdentityKeyHD(mnemonic, keyIndex, network);

  return createIdentityKeyFromKeyPair(
    id,
    name,
    keyType,
    purpose,
    securityLevel,
    privateKey,
    publicKey,
    network,
    derivationPath
  );
}

/**
 * Generate default identity keys using HD derivation
 */
export function generateDefaultIdentityKeysHD(
  network: string,
  mnemonic: string
): IdentityKeyConfig[] {
  return [
    generateIdentityKeyFromMnemonic(0, 'Master', 'ECDSA_SECP256K1', 'AUTHENTICATION', 'MASTER', network, mnemonic, 0),
    generateIdentityKeyFromMnemonic(1, 'High Auth', 'ECDSA_SECP256K1', 'AUTHENTICATION', 'HIGH', network, mnemonic, 1),
    generateIdentityKeyFromMnemonic(2, 'Critical Auth', 'ECDSA_SECP256K1', 'AUTHENTICATION', 'CRITICAL', network, mnemonic, 2),
    generateIdentityKeyFromMnemonic(3, 'Transfer', 'ECDSA_SECP256K1', 'TRANSFER', 'CRITICAL', network, mnemonic, 3),
    generateIdentityKeyFromMnemonic(4, 'Encryption', 'ECDSA_SECP256K1', 'ENCRYPTION', 'MEDIUM', network, mnemonic, 4),
    generateIdentityKeyFromMnemonic(5, 'Decryption', 'ECDSA_SECP256K1', 'DECRYPTION', 'MEDIUM', network, mnemonic, 5),
  ];
}

/**
 * Compare two Uint8Arrays for equality
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Find which identity key matches the given private key WIF.
 * Returns the matching key info including id, securityLevel, and purpose, or null if no match.
 */
export function findMatchingKeyIndex(
  privateKeyWif: string,
  identityPublicKeys: IdentityPublicKeyInfo[],
  network: string
): { keyId: number; securityLevel: number; purpose: number; publicKey: Uint8Array } | null {
  // Decode the WIF to get the private key
  let privateKey: Uint8Array;
  try {
    const decoded = wifToPrivateKey(privateKeyWif);
    privateKey = decoded.privateKey;

    // Validate network prefix
    const networkConfig = getNetwork(network);
    if (decoded.prefix !== networkConfig.wifPrefix) {
      return null; // Network mismatch
    }
  } catch {
    return null; // Invalid WIF format
  }

  // Derive the public key from the private key
  const publicKey = getPublicKey(privateKey);
  const publicKeyHash = hash160(publicKey);

  // Check against each identity key
  for (const key of identityPublicKeys) {
    // Key type 0 = ECDSA_SECP256K1 (33-byte compressed public key)
    // Key type 2 = ECDSA_HASH160 (20-byte hash160)
    if (key.type === 0) {
      // Compare full public key
      if (bytesEqual(publicKey, key.data)) {
        return { keyId: key.id, securityLevel: key.securityLevel, purpose: key.purpose, publicKey };
      }
    } else if (key.type === 2) {
      // Compare hash160
      if (bytesEqual(publicKeyHash, key.data)) {
        return { keyId: key.id, securityLevel: key.securityLevel, purpose: key.purpose, publicKey };
      }
    }
  }

  return null;
}

/**
 * Get security level name from numeric value
 */
export function getSecurityLevelName(level: number): string {
  switch (level) {
    case 0: return 'MASTER';
    case 1: return 'CRITICAL';
    case 2: return 'HIGH';
    case 3: return 'MEDIUM';
    default: return `UNKNOWN(${level})`;
  }
}

/**
 * Check if a security level is allowed for DPNS registration
 * Only CRITICAL (1) and HIGH (2) are allowed
 */
export function isSecurityLevelAllowedForDpns(level: number): boolean {
  return level === 1 || level === 2;
}

/**
 * Get purpose name from numeric value
 */
export function getPurposeName(purpose: number): string {
  switch (purpose) {
    case 0: return 'AUTHENTICATION';
    case 1: return 'ENCRYPTION';
    case 2: return 'DECRYPTION';
    case 3: return 'TRANSFER';
    case 4: return 'OWNER';
    case 5: return 'VOTING';
    default: return `UNKNOWN(${purpose})`;
  }
}

/**
 * Check if a key purpose is allowed for DPNS registration
 * Only AUTHENTICATION (0) is allowed
 */
export function isPurposeAllowedForDpns(purpose: number): boolean {
  return purpose === 0;
}

import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/**
 * BIP44 purpose for standard derivations
 */
const BIP44_PURPOSE = 44;

/**
 * DIP-0009 purpose for Dash-specific derivations
 */
const DIP9_PURPOSE = 9;

/**
 * DIP-0013 feature for identity keys
 */
const DIP13_IDENTITY_FEATURE = 5;

/**
 * Key type index for ECDSA (per DIP-0013)
 */
const ECDSA_KEY_TYPE = 0;

/**
 * Identity index (first identity)
 */
const IDENTITY_INDEX = 0;

/**
 * Get coin type based on network
 * Mainnet: 5 (Dash)
 * Testnet: 1 (Testnet)
 */
export function getCoinType(network: string): number {
  return network === 'mainnet' ? 5 : 1;
}

/**
 * Generate a new BIP39 mnemonic
 * @param strength - 128 for 12 words, 256 for 24 words
 */
export function generateNewMnemonic(strength: 128 | 256 = 128): string {
  return generateMnemonic(wordlist, strength);
}

/**
 * Derive HD master key from mnemonic
 * @param mnemonic - BIP39 mnemonic words
 * @param passphrase - Optional BIP39 passphrase (empty by default)
 */
export function mnemonicToHDKey(mnemonic: string, passphrase: string = ''): HDKey {
  const seed = mnemonicToSeedSync(mnemonic, passphrase);
  return HDKey.fromMasterSeed(seed);
}

/**
 * Get asset lock key derivation path (BIP44)
 * Path: m/44'/[coin_type]'/0'/0/0
 */
export function getAssetLockDerivationPath(network: string): string {
  const coinType = getCoinType(network);
  return `m/${BIP44_PURPOSE}'/${coinType}'/0'/0/0`;
}

/**
 * Get identity key derivation path (DIP-0013)
 * Path: m/9'/[coin_type]'/5'/0'/[key_type]'/[identity_index]'/[key_index]'
 *
 * @param keyIndex - The index of the key (0, 1, 2, 3...)
 * @param network - Network for coin type selection
 * @param identityIndex - The identity index (default 0 for first identity)
 * @param keyType - Key type (0 for ECDSA, default)
 */
export function getIdentityKeyDerivationPath(
  keyIndex: number,
  network: string,
  identityIndex: number = IDENTITY_INDEX,
  keyType: number = ECDSA_KEY_TYPE
): string {
  const coinType = getCoinType(network);
  return `m/${DIP9_PURPOSE}'/${coinType}'/${DIP13_IDENTITY_FEATURE}'/0'/${keyType}'/${identityIndex}'/${keyIndex}'`;
}

/**
 * Derive a key at the specified path
 * @param hdKey - Master HD key
 * @param path - Derivation path (e.g., "m/44'/5'/0'/0/0")
 * @returns Object with privateKey and publicKey as Uint8Array
 */
export function deriveKeyAtPath(
  hdKey: HDKey,
  path: string
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const derived = hdKey.derive(path);

  if (!derived.privateKey || !derived.publicKey) {
    throw new Error(`Failed to derive key at path: ${path}`);
  }

  return {
    privateKey: derived.privateKey,
    publicKey: derived.publicKey,
  };
}

/**
 * Derive the asset lock key pair from mnemonic
 * Uses BIP44 path: m/44'/[coin_type]'/0'/0/0
 */
export function deriveAssetLockKeyPair(
  mnemonic: string,
  network: string
): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  derivationPath: string;
} {
  const hdKey = mnemonicToHDKey(mnemonic);
  const path = getAssetLockDerivationPath(network);
  const { privateKey, publicKey } = deriveKeyAtPath(hdKey, path);

  return { privateKey, publicKey, derivationPath: path };
}

/**
 * Derive an identity key from mnemonic at specified index
 * Uses DIP-0013 path: m/9'/[coin_type]'/5'/0'/0'/[identity_index]'/[key_index]'
 */
export function deriveIdentityKey(
  mnemonic: string,
  keyIndex: number,
  network: string,
  identityIndex: number = IDENTITY_INDEX
): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  derivationPath: string;
} {
  const hdKey = mnemonicToHDKey(mnemonic);
  const path = getIdentityKeyDerivationPath(keyIndex, network, identityIndex);
  const { privateKey, publicKey } = deriveKeyAtPath(hdKey, path);

  return { privateKey, publicKey, derivationPath: path };
}

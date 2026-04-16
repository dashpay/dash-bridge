import {
  EvoSDK,
  AssetLockProof,
  Identity,
  IdentityPublicKey,
  IdentityPublicKeyInCreation,
  IdentitySigner,
  PrivateKey,
  PlatformAddressSigner,
} from '@dashevo/evo-sdk';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import type { PublicKeyInfo, IdentityKeyConfig, AssetLockProofData } from '../types.js';
import { withRetry, type RetryOptions } from '../utils/retry.js';

/**
 * Compute hash160 (RIPEMD160(SHA256(data))) of a buffer
 */
function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

function hexToBytes(hex: string): Uint8Array {
  if (!hex || hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}


function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const PLATFORM_REQUEST_SETTINGS = {
  connectTimeoutMs: 10000,
  timeoutMs: 20000,
  retries: 2,
  banFailedAddress: true,
} as const;

const PLATFORM_PUT_SETTINGS = {
  ...PLATFORM_REQUEST_SETTINGS,
  waitTimeoutMs: 45000,
} as const;

function createPlatformSdk(
  network: 'testnet' | 'mainnet',
  trusted: boolean
): EvoSDK {
  const options = { settings: PLATFORM_REQUEST_SETTINGS };

  if (network === 'mainnet') {
    return trusted ? EvoSDK.mainnetTrusted(options) : EvoSDK.mainnet(options);
  }

  return trusted ? EvoSDK.testnetTrusted(options) : EvoSDK.testnet(options);
}

/**
 * Identity key types as defined by Dash Platform
 */
export const KeyType = {
  ECDSA_SECP256K1: 0,
  BLS12_381: 1,
  ECDSA_HASH160: 2,
  BIP13_SCRIPT_HASH: 3,
  EDDSA_25519_HASH160: 4,
} as const;

/**
 * Key purposes as defined by Dash Platform
 */
export const KeyPurpose = {
  AUTHENTICATION: 0,
  ENCRYPTION: 1,
  DECRYPTION: 2,
  TRANSFER: 3,
  OWNER: 4,
  VOTING: 5,
} as const;

/**
 * Security levels as defined by Dash Platform
 */
export const SecurityLevel = {
  MASTER: 0,
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
} as const;

/**
 * Key type strings as expected by SDK
 */
export const KeyTypeString = {
  ECDSA_SECP256K1: 'ECDSA_SECP256K1',
  BLS12_381: 'BLS12_381',
  ECDSA_HASH160: 'ECDSA_HASH160',
} as const;

/**
 * Key purpose strings as expected by SDK
 */
export const KeyPurposeString = {
  AUTHENTICATION: 'AUTHENTICATION',
  ENCRYPTION: 'ENCRYPTION',
  DECRYPTION: 'DECRYPTION',
  TRANSFER: 'TRANSFER',
  OWNER: 'OWNER',
  VOTING: 'VOTING',
} as const;

/**
 * Security level strings as expected by SDK
 */
export const SecurityLevelString = {
  MASTER: 'MASTER',
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
} as const;

/**
 * Create a public key info object for identity registration
 */
export function createPublicKeyInfo(
  id: number,
  publicKeyBase64: string,
  options: {
    type?: number;
    purpose?: number;
    securityLevel?: number;
    readOnly?: boolean;
  } = {}
): PublicKeyInfo {
  return {
    id,
    type: options.type ?? KeyType.ECDSA_SECP256K1,
    purpose: options.purpose ?? KeyPurpose.AUTHENTICATION,
    securityLevel: options.securityLevel ?? SecurityLevel.MASTER,
    data: publicKeyBase64,
    readOnly: options.readOnly ?? false,
  };
}

/**
 * Convert a public key bytes to base64 for SDK
 */
export function publicKeyToBase64(publicKey: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < publicKey.length; i++) {
    binary += String.fromCharCode(publicKey[i]);
  }
  return btoa(binary);
}

/**
 * Register an identity on Dash Platform
 */
export async function registerIdentity(
  assetLockProofData: AssetLockProofData,
  assetLockPrivateKeyWif: string,
  identityKeys: IdentityKeyConfig[],
  network: 'testnet' | 'mainnet',
  retryOptions?: RetryOptions
): Promise<{ identityId: string; balance: number; revision: number }> {
  // Initialize SDK for the target network
  const sdk = createPlatformSdk(network, true);

  // Connect to the network with retry
  console.log(`Connecting to ${network}...`);
  await withRetry(() => sdk.connect(), retryOptions);
  console.log('Connected to Platform');

  // Build typed AssetLockProof from raw components
  const proof = AssetLockProof.createInstantAssetLockProof(
    assetLockProofData.instantLockBytes,
    assetLockProofData.transactionBytes,
    assetLockProofData.outputIndex
  );
  const identityId = proof.createIdentityId().toString();
  const identity = new Identity(identityId);
  const signer = new IdentitySigner();

  for (const key of identityKeys) {
    const keyBytes = key.keyType === 'ECDSA_HASH160'
      ? hash160(key.publicKey)
      : key.publicKey;

    const publicKey = new IdentityPublicKey({
      keyId: key.id,
      purpose: key.purpose,
      securityLevel: key.securityLevel,
      keyType: key.keyType,
      isReadOnly: false,
      data: keyBytes,
    });
    identity.addPublicKey(publicKey);
    signer.addKeyFromWif(key.privateKeyWif);
  }

  const assetLockPrivateKey = PrivateKey.fromWIF(assetLockPrivateKeyWif);

  console.log('Creating identity with', identityKeys.length, 'keys...');
  await withRetry(
    () => sdk.identities.create({
      identity,
      assetLockProof: proof,
      assetLockPrivateKey,
      signer,
      settings: PLATFORM_PUT_SETTINGS,
    }),
    retryOptions
  );

  const balanceAndRevision = await withRetry(
    () => sdk.identities.balanceAndRevision(identityId),
    retryOptions
  );

  console.log('Identity created:', identityId);

  return {
    identityId,
    balance: Number(balanceAndRevision?.balance ?? 0n),
    revision: Number(balanceAndRevision?.revision ?? 0n),
  };
}

/**
 * Top up an existing identity on Dash Platform
 *
 * This is simpler than identity creation:
 * - No identity keys needed
 * - Just needs identityId, proof, and asset lock private key
 *
 * Note: Uses trusted mode because topUp needs to fetch the identity first,
 * which requires quorum verification that's only available in trusted mode.
 */
export async function topUpIdentity(
  identityId: string,
  assetLockProofData: AssetLockProofData,
  assetLockPrivateKeyWif: string,
  network: 'testnet' | 'mainnet',
  retryOptions?: RetryOptions
): Promise<{ success: boolean; balance?: number }> {
  // Initialize SDK for the target network (trusted mode required for identity fetch)
  const sdk = createPlatformSdk(network, true);

  // Connect to the network with retry
  console.log(`Connecting to ${network}...`);
  await withRetry(() => sdk.connect(), retryOptions);
  console.log('Connected to Platform');

  const identity = await withRetry(
    () => sdk.identities.fetch(identityId),
    retryOptions
  );
  if (!identity) {
    throw new Error(`Identity not found: ${identityId}`);
  }

  const proof = AssetLockProof.createInstantAssetLockProof(
    assetLockProofData.instantLockBytes,
    assetLockProofData.transactionBytes,
    assetLockProofData.outputIndex
  );
  const assetLockPrivateKey = PrivateKey.fromWIF(assetLockPrivateKeyWif);

  console.log('Topping up identity:', identityId);
  const result = await withRetry(
    () => sdk.identities.topUp({
      identity,
      assetLockProof: proof,
      assetLockPrivateKey,
      settings: PLATFORM_PUT_SETTINGS,
    }),
    retryOptions
  );

  console.log('Top-up result:', result);

  return {
    success: true,
    balance: Number(result),
  };
}

/**
 * Configuration for a key to add during identity update
 */
export interface AddKeyConfig {
  keyType: string;  // 'ECDSA_SECP256K1' | 'ECDSA_HASH160'
  purpose: string;  // 'AUTHENTICATION' | 'TRANSFER' | etc.
  securityLevel: string;  // 'CRITICAL' | 'HIGH' | 'MEDIUM'
  /** For generated keys: hex-encoded private key (SDK derives public key) */
  privateKeyHex?: string;
  /** For generated keys: hex-encoded public key */
  publicKeyHex?: string;
  /** For imported keys: base64-encoded public key data */
  publicKeyBase64?: string;
  /** For generated keys: WIF-encoded private key (added to signer for update transitions) */
  privateKeyWif?: string;
}

/**
 * Update an identity on Dash Platform (add/disable keys)
 *
 * Requirements:
 * - privateKeyWif must be for a MASTER or CRITICAL level key
 * - Cannot disable the key used for signing
 *
 * Note: Uses trusted mode because update needs to fetch the identity first,
 * which requires quorum verification that's only available in trusted mode.
 */
export async function updateIdentity(
  identityId: string,
  privateKeyWif: string,
  addPublicKeys: AddKeyConfig[],
  disablePublicKeyIds: number[],
  network: 'testnet' | 'mainnet',
  retryOptions?: RetryOptions
): Promise<{ success: boolean; error?: string }> {
  // Initialize SDK for the target network (trusted mode required for identity fetch)
  const sdk = createPlatformSdk(network, true);

  console.log(`Connecting to ${network}...`);
  await withRetry(() => sdk.connect(), retryOptions);
  console.log('Connected to Platform');

  try {
    console.log('Updating identity:', identityId);
    console.log('Adding', addPublicKeys.length, 'keys, disabling', disablePublicKeyIds.length, 'keys');

    const identity = await withRetry(
      () => sdk.identities.fetch(identityId),
      retryOptions
    );
    if (!identity) {
      throw new Error(`Identity not found: ${identityId}`);
    }

    const signer = new IdentitySigner();
    signer.addKeyFromWif(privateKeyWif);

    // Add private keys for new keys being added (SDK needs them to sign the transition)
    for (const key of addPublicKeys) {
      if (key.privateKeyWif) {
        signer.addKeyFromWif(key.privateKeyWif);
      }
    }

    const existingKeys = identity.publicKeys;
    const maxKeyId = existingKeys.reduce((max: number, key: { keyId: number }) => Math.max(max, key.keyId), -1);

    const formattedAddKeys: IdentityPublicKeyInCreation[] = addPublicKeys.map((key, index) => {
      const isHash160Type = key.keyType === 'ECDSA_HASH160';
      let keyDataBytes: Uint8Array;

      if (isHash160Type && key.publicKeyHex) {
        keyDataBytes = hash160(hexToBytes(key.publicKeyHex));
      } else if (key.publicKeyHex) {
        keyDataBytes = hexToBytes(key.publicKeyHex);
      } else if (key.publicKeyBase64) {
        keyDataBytes = base64ToBytes(key.publicKeyBase64);
      } else {
        throw new Error('Missing key data for identity update');
      }

      return new IdentityPublicKeyInCreation({
        keyId: maxKeyId + index + 1,
        purpose: key.purpose,
        securityLevel: key.securityLevel,
        keyType: key.keyType,
        isReadOnly: false,
        data: keyDataBytes,
      });
    });

    console.log('Formatted keys to add:', JSON.stringify(formattedAddKeys, null, 2));

    await withRetry(
      () => sdk.identities.update({
        identity,
        signer,
        addPublicKeys: formattedAddKeys.length > 0
          ? formattedAddKeys
          : undefined,
        disablePublicKeys: disablePublicKeyIds.length > 0
          ? disablePublicKeyIds
          : undefined,
        settings: PLATFORM_PUT_SETTINGS,
      }),
      retryOptions
    );

    console.log('Update completed');

    return { success: true };
  } catch (error) {
    console.error('Identity update error:', error);
    // WasmSdkError is not a standard Error, so check for message property
    const errorMessage = (error && typeof error === 'object' && 'message' in error)
      ? String((error as { message: unknown }).message)
      : (error instanceof Error ? error.message : String(error));
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Send credits to a Platform address from an asset lock
 *
 * Accepts any bech32m platform address as the recipient.
 * Uses sdk.addresses.fundFromAssetLock() with an empty PlatformAddressSigner
 * since we don't have (or need) the recipient's private key.
 */
export async function sendToPlatformAddress(
  recipientAddress: string,
  assetLockProofData: AssetLockProofData,
  assetLockPrivateKeyWif: string,
  network: 'testnet' | 'mainnet',
  retryOptions?: RetryOptions
): Promise<{ success: boolean; recipientAddress: string }> {
  const sdk = createPlatformSdk(network, false);

  console.log(`Connecting to ${network}...`);
  await withRetry(() => sdk.connect(), retryOptions);
  console.log('Connected to Platform');

  // Build typed AssetLockProof from raw components
  const assetLockProof = AssetLockProof.createInstantAssetLockProof(
    assetLockProofData.instantLockBytes,
    assetLockProofData.transactionBytes,
    assetLockProofData.outputIndex
  );

  // Build the asset lock private key
  const assetLockPrivateKey = PrivateKey.fromWIF(assetLockPrivateKeyWif);

  // Empty signer — recipient does not need to sign for receiving
  const signer = new PlatformAddressSigner();

  console.log('Sending to platform address:', recipientAddress);

  // Pass output as a plain object — the WASM serde deserializer expects
  // { address: string } not a PlatformAddressOutput WASM instance
  const result = await withRetry(
    () => sdk.addresses.fundFromAssetLock({
      assetLockProof,
      assetLockPrivateKey,
      outputs: [{ address: recipientAddress }] as any,
      signer,
      feeStrategy: [{ type: 'reduceOutput', index: 0 }] as any,
      settings: PLATFORM_PUT_SETTINGS,
    }),
    retryOptions
  );

  console.log('Send to address result:', result);
  if (result == null) {
    throw new Error('Failed to send to platform address: fundFromAssetLock returned no result');
  }
  if (typeof result === 'object') {
    const maybeResult = result as {
      success?: unknown;
      error?: unknown;
    };

    if (
      maybeResult.success === false
      || maybeResult.error !== undefined
    ) {
      const details = maybeResult.error ?? 'unknown error';
      throw new Error(`Failed to send to platform address: ${String(details)}`);
    }
  }

  return {
    success: true,
    recipientAddress,
  };
}

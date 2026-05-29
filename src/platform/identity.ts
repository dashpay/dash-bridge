import {
  AssetLockProof,
  Identity,
  IdentityPublicKey,
  IdentityPublicKeyInCreation,
  IdentitySigner,
  OutPoint,
  PrivateKey,
  PlatformAddressSigner,
  type PurposeLike,
  type SecurityLevelLike,
  type KeyTypeLike,
} from '@dashevo/evo-sdk';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import type { PublicKeyInfo, IdentityKeyConfig, AssetLockProofData } from '../types.js';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import { bytesToHex } from '../utils/hex.js';
import { describeIslock, diffIslockInputsAgainstTx } from '../utils/islock-debug.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import dashcoreLib from '@dashevo/dashcore-lib';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DashcoreTransaction = (dashcoreLib as any).Transaction;
import {
  PLATFORM_PUT_SETTINGS,
  fetchIdentityWithSdk,
  getIdentityBalanceAndRevisionWithSdk,
  waitForIdentityByPolling,
  withConnectedPlatformSdk,
  withPlatformOperationTimeout,
} from './client.js';
import { getNetwork } from '../config.js';

/**
 * Compute hash160 (RIPEMD160(SHA256(data))) of a buffer
 */
function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * Build the typed SDK AssetLockProof from our discriminated proof data.
 */
function toSdkProof(data: AssetLockProofData): AssetLockProof {
  if (data.type === 'instant') {
    return AssetLockProof.createInstantAssetLockProof(
      data.instantLockBytes,
      data.transactionBytes,
      data.outputIndex
    );
  }
  return AssetLockProof.createChainAssetLockProof(
    data.coreChainLockedHeight,
    new OutPoint(data.txid, data.vout)
  );
}

/**
 * Dump everything we are about to feed into the platform SDK for an
 * asset-lock-proof-based call. Used to debug "Instant lock proof signature
 * is invalid or wasn't created recently" errors from Platform.
 */
function logAssetLockProofForDebug(
  proofData: AssetLockProofData,
  network: string,
  context: string
): void {
  if (proofData.type === 'chain') {
    console.log('[islock-debug] Asset lock proof debug dump (chain):', {
      context,
      network,
      type: 'chain',
      coreChainLockedHeight: proofData.coreChainLockedHeight,
      txid: proofData.txid,
      vout: proofData.vout,
      timestampIso: new Date().toISOString(),
    });
    return;
  }
  const islockDebug = describeIslock(proofData.instantLockBytes, `proof:${context}`);
  const txHex = bytesToHex(proofData.transactionBytes);

  let txInputs: Array<{ txid: string; vout: number }> = [];
  let parsedTxTxid: string | undefined;
  let parsedTxVersion: number | undefined;
  let parsedTxType: number | undefined;
  let outputCount: number | undefined;
  try {
    // Parse the asset lock tx with dashcore-lib so we can compare its inputs
    // and txid against the IS lock we just got back.
    const tx = new DashcoreTransaction(txHex);
    parsedTxTxid = tx.hash || tx.id;
    parsedTxVersion = tx.version;
    parsedTxType = tx.type;
    outputCount = tx.outputs?.length;
    txInputs = (tx.inputs || []).map((i: { prevTxId: Buffer; outputIndex: number }) => ({
      txid: Buffer.from(i.prevTxId).toString('hex'),
      vout: i.outputIndex,
    }));
  } catch (err) {
    console.warn('[islock-debug] Failed to parse asset lock tx for debug:', err);
  }

  const inputDiff = islockDebug.parsed
    ? diffIslockInputsAgainstTx(islockDebug.parsed.inputs, txInputs)
    : { matches: false, details: ['islock could not be parsed'] };

  const txidMatches =
    islockDebug.parsed && parsedTxTxid
      ? islockDebug.parsed.txid === parsedTxTxid
      : undefined;

  console.log('[islock-debug] Asset lock proof debug dump:', {
    context,
    network,
    outputIndex: proofData.outputIndex,
    transactionBytesLength: proofData.transactionBytes.length,
    transactionHex: txHex,
    parsedTx: {
      txid: parsedTxTxid,
      version: parsedTxVersion,
      type: parsedTxType,
      outputCount,
      inputs: txInputs,
    },
    islock: islockDebug,
    consistency: {
      txidMatches,
      inputsMatch: inputDiff.matches,
      inputDiffDetails: inputDiff.details,
    },
    timestampIso: new Date().toISOString(),
  });
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
  network: string,
  retryOptions?: RetryOptions
): Promise<{ identityId: string; balance: number; revision: number }> {
  logAssetLockProofForDebug(assetLockProofData, network, 'registerIdentity');
  return withConnectedPlatformSdk(network, async (sdk) => {
    const proof = toSdkProof(assetLockProofData);
    const identityId = proof.createIdentityId().toString();
    console.log('[islock-debug] Derived identityId from proof:', identityId);
    const identity = new Identity(identityId);
    const signer = new IdentitySigner();

    for (const key of identityKeys) {
      const keyBytes = key.keyType === 'ECDSA_HASH160'
        ? hash160(key.publicKey)
        : key.publicKey;

      const publicKey = new IdentityPublicKey({
        keyId: key.id,
        purpose: key.purpose.toLowerCase() as PurposeLike,
        securityLevel: key.securityLevel.toLowerCase() as SecurityLevelLike,
        keyType: key.keyType.toLowerCase() as KeyTypeLike,
        isReadOnly: false,
        data: keyBytes,
      });
      identity.addPublicKey(publicKey);
      signer.addKeyFromWif(key.privateKeyWif);
    }

    const assetLockPrivateKey = PrivateKey.fromWIF(assetLockPrivateKeyWif);

    // On a NON-TRUSTED devnet, the SDK has no quorum context, so
    // `identities.create` cannot complete its proof-verifying wait phase:
    // every retry of `wait_for_state_transition_result` fails inside
    // Drive::verify_state_transition_was_executed_with_proof, and the SDK
    // burns minutes cycling through masternodes. The fix: force the wait
    // phase to fail fast (`retries: 0`), let the broadcast succeed, then
    // poll `getIdentityUnproved` until the identity appears on-chain.
    // Trusted devnets (SDK >= 3.1.0-dev.7, `useTrustedContext: true`) take
    // the normal wait path same as mainnet/testnet.
    const networkConfig = getNetwork(network);
    const isNonTrustedDevnet =
      networkConfig.type === 'devnet' && !networkConfig.useTrustedContext;

    console.log('Creating identity with', identityKeys.length, 'keys...');
    if (isNonTrustedDevnet) {
      // Do NOT pass `waitTimeoutMs` here: rs-sdk implements that via
      // `tokio::time::timeout`, and the WASM build of the SDK ships without
      // a working time backend, so any path that touches `wait_timeout`
      // panics with "time not implemented on this platform" (Rust std's
      // `unsupported/time.rs`). Instead, we cap the wait phase by setting
      // `retries: 0` (one attempt only — Tenderdash's server-side
      // wait_for_state_transition_result returns within ~30s on its own
      // deadline) and rely on the outer `withPlatformOperationTimeout`
      // (45s) as the wall-clock safety net.
      const broadcastSettings = {
        ...PLATFORM_PUT_SETTINGS,
        retries: 0,
      } as const;
      let sdkError: unknown;
      try {
        await withPlatformOperationTimeout(
          sdk.identities.create({
            identity,
            assetLockProof: proof,
            assetLockPrivateKey,
            signer,
            settings: broadcastSettings,
          }),
          'broadcasting identity create state transition'
        );
        console.log('Identity create wait phase completed without error');
      } catch (error) {
        // Expected on non-trusted devnet: the wait phase cannot verify
        // proofs without a quorum context (WasmContext::get_quorum_public_key
        // returns an error). The broadcast itself may have succeeded — we
        // cannot tell from the error alone, so we fall through to polling.
        // If the broadcast also failed, polling will time out and the
        // original error is surfaced in the timeout message for diagnosis.
        sdkError = error;
        console.warn(
          '[devnet] identities.create returned an error (expected when ' +
            'proof verification is unavailable); falling back to polling. Error:',
          error instanceof Error ? error.message : error
        );
      }

      console.log('Polling for identity', identityId, 'via getIdentityUnproved...');
      const appeared = await waitForIdentityByPolling(sdk, identityId, 60000, 2000);
      if (!appeared) {
        const sdkErrorMsg =
          sdkError instanceof Error ? sdkError.message : String(sdkError ?? 'no SDK error');
        throw new Error(
          `Identity ${identityId} did not appear on Platform within 60s polling window. ` +
            `The broadcast may have failed (was not just the wait phase). ` +
            `Original SDK error: ${sdkErrorMsg}`
        );
      }
      console.log('Identity created (observed via polling):', identityId);
      return { identityId, balance: 0, revision: 0 };
    }

    await withPlatformOperationTimeout(
      withRetry(
        () => sdk.identities.create({
          identity,
          assetLockProof: proof,
          assetLockPrivateKey,
          signer,
          settings: PLATFORM_PUT_SETTINGS,
        }),
        retryOptions
      ),
      'waiting for identity creation confirmation'
    );

    const balanceAndRevision = await getIdentityBalanceAndRevisionWithSdk(
      sdk,
      identityId,
      retryOptions
    );

    console.log('Identity created:', identityId);

    return {
      identityId,
      balance: balanceAndRevision.balance,
      revision: balanceAndRevision.revision,
    };
  }, retryOptions);
}

/**
 * Top up an existing identity on Dash Platform
 *
 * This is simpler than identity creation:
 * - No identity keys needed
 * - Just needs identityId, proof, and asset lock private key
 *
 * Note: trusted/untrusted mode is decided per-network in
 * createPlatformSdk. Mainnet/testnet are always trusted; devnets are
 * trusted when `useTrustedContext` is set on the network config (SDK >=
 * 3.1.0-dev.7). On a non-trusted devnet, fetching the existing identity
 * may fail because there is no quorum context to verify the response
 * proofs against — top up requires trusted-context mode there.
 */
export async function topUpIdentity(
  identityId: string,
  assetLockProofData: AssetLockProofData,
  assetLockPrivateKeyWif: string,
  network: string,
  retryOptions?: RetryOptions
): Promise<{ success: boolean; balance?: number }> {
  logAssetLockProofForDebug(assetLockProofData, network, `topUpIdentity:${identityId}`);
  return withConnectedPlatformSdk(network, async (sdk) => {
    const identity = await fetchIdentityWithSdk(sdk, identityId, retryOptions);
    if (!identity) {
      throw new Error(`Identity not found: ${identityId}`);
    }

    const proof = toSdkProof(assetLockProofData);
    const assetLockPrivateKey = PrivateKey.fromWIF(assetLockPrivateKeyWif);

    console.log('Topping up identity:', identityId);
    const result = await withPlatformOperationTimeout(
      withRetry(
        () => sdk.identities.topUp({
          identity,
          assetLockProof: proof,
          assetLockPrivateKey,
          settings: PLATFORM_PUT_SETTINGS,
        }),
        retryOptions
      ),
      'waiting for identity top-up confirmation'
    );

    console.log('Top-up result:', result);

    return {
      success: true,
      balance: Number(result),
    };
  }, retryOptions);
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
 * Note: like `topUpIdentity`, this fetches the existing identity via the
 * SDK and so requires a quorum context — works on trusted devnets only.
 */
export async function updateIdentity(
  identityId: string,
  privateKeyWif: string,
  addPublicKeys: AddKeyConfig[],
  disablePublicKeyIds: number[],
  network: string,
  retryOptions?: RetryOptions
): Promise<{ success: boolean; error?: string }> {
  return withConnectedPlatformSdk(network, async (sdk) => {
    try {
      console.log('Updating identity:', identityId);
      console.log('Adding', addPublicKeys.length, 'keys, disabling', disablePublicKeyIds.length, 'keys');

      const identity = await fetchIdentityWithSdk(sdk, identityId, retryOptions);
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
          purpose: key.purpose.toLowerCase() as PurposeLike,
          securityLevel: key.securityLevel.toLowerCase() as SecurityLevelLike,
          keyType: key.keyType.toLowerCase() as KeyTypeLike,
          isReadOnly: false,
          data: keyDataBytes,
        });
      });

      console.log('Formatted keys to add:', JSON.stringify(formattedAddKeys, null, 2));

      await withPlatformOperationTimeout(
        withRetry(
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
        ),
        'waiting for identity update confirmation'
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
  }, retryOptions);
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
  network: string,
  retryOptions?: RetryOptions
): Promise<{ success: boolean; recipientAddress: string }> {
  logAssetLockProofForDebug(
    assetLockProofData,
    network,
    `sendToPlatformAddress:${recipientAddress}`
  );
  return withConnectedPlatformSdk(network, async (sdk) => {
    const assetLockProof = toSdkProof(assetLockProofData);

    // Build the asset lock private key
    const assetLockPrivateKey = PrivateKey.fromWIF(assetLockPrivateKeyWif);

    // Empty signer — recipient does not need to sign for receiving
    const signer = new PlatformAddressSigner();

    console.log('Sending to platform address:', recipientAddress);

    // Pass output as a plain object — the WASM serde deserializer expects
    // { address: string } not a PlatformAddressOutput WASM instance
    const result = await withPlatformOperationTimeout(
      withRetry(
        () => sdk.addresses.fundFromAssetLock({
          assetLockProof,
          assetLockPrivateKey,
          outputs: [{ address: recipientAddress }] as any,
          signer,
          feeStrategy: [{ type: 'reduceOutput', index: 0 }] as any,
          settings: PLATFORM_PUT_SETTINGS,
        }),
        retryOptions
      ),
      'waiting for platform address funding confirmation'
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
  }, retryOptions);
}

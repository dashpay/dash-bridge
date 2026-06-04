import type { DpnsUsernameEntry, DpnsRegistrationResult, IdentityPublicKeyInfo } from '../types.js';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import {
  fetchIdentityPublicKeyRecords,
  fetchIdentityWithSdk,
  withConnectedPlatformSdk,
} from './client.js';
import { loadSdkModule } from './sdkModule.js';
import {
  convertToHomographSafe,
  isContestedUsername,
} from './dpns-utils.js';

export {
  validateDpnsLabel,
  convertToHomographSafe,
  isContestedUsername,
  createUsernameEntry,
  createEmptyUsernameEntry,
  shouldShowContestedWarning,
  countUsernameStatuses,
} from './dpns-utils.js';

/**
 * Fetch an identity's public keys from the network
 */
export async function getIdentityPublicKeys(
  identityId: string,
  network: string,
  retryOptions?: RetryOptions
): Promise<IdentityPublicKeyInfo[]> {
  console.log(`Fetching identity keys for ${identityId} on ${network}...`);
  const keysArray = await fetchIdentityPublicKeyRecords(identityId, network, retryOptions);

  console.log('Keys response:', keysArray);

  // Convert the keys to our format
  const result: IdentityPublicKeyInfo[] = [];

  for (const key of keysArray) {
    console.log('Processing key:', key);

    // SDK v3 response format: keyId, keyType, publicKeyData, purpose, securityLevel
    const id = key.keyId;

    // Convert keyType string to number
    const typeStr = key.keyType ?? 'ECDSA_SECP256K1';
    const type = typeStr === 'ECDSA_SECP256K1' ? 0 : typeStr === 'ECDSA_HASH160' ? 2 : 0;

    // Convert purpose string to number
    const purposeStr = key.purpose ?? 'AUTHENTICATION';
    const purposeMap: Record<string, number> = {
      'AUTHENTICATION': 0, 'ENCRYPTION': 1, 'DECRYPTION': 2,
      'TRANSFER': 3, 'OWNER': 4, 'VOTING': 5
    };
    const purpose = purposeMap[purposeStr] ?? 0;

    // Convert securityLevel string to number
    const levelStr = key.securityLevel ?? 'MASTER';
    const levelMap: Record<string, number> = {
      'MASTER': 0, 'CRITICAL': 1, 'HIGH': 2, 'MEDIUM': 3
    };
    const securityLevel = levelMap[levelStr] ?? 0;

    // SDK v3.0.1 returns key data as `data` (hex string)
    const rawData = key.data;

    // Convert hex string to Uint8Array
    let data: Uint8Array;
    if (typeof rawData === 'string' && /^[0-9a-fA-F]+$/.test(rawData)) {
      data = new Uint8Array(rawData.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    } else if (typeof rawData === 'string') {
      // Try base64
      data = new Uint8Array(atob(rawData).split('').map(c => c.charCodeAt(0)));
    } else {
      console.warn('Unexpected key data format:', rawData);
      data = new Uint8Array(0);
    }

    // SDK v3.0.1 uses disabledAt timestamp instead of disabled boolean
    const isDisabled = key.disabledAt !== undefined;

    result.push({
      id,
      type,
      purpose,
      securityLevel,
      data,
      isDisabled,
    });
  }

  console.log('Parsed keys:', result);
  return result;
}

/**
 * Check if a username is available on the network
 */
export async function checkUsernameAvailability(
  label: string,
  network: string,
  retryOptions?: RetryOptions
): Promise<boolean> {
  return withConnectedPlatformSdk(
    network,
    (sdk) => withRetry(() => sdk.dpns.isNameAvailable(label), retryOptions),
    retryOptions
  );
}

/**
 * Check availability for multiple usernames
 */
export async function checkMultipleAvailability(
  entries: DpnsUsernameEntry[],
  network: string,
  retryOptions?: RetryOptions
): Promise<DpnsUsernameEntry[]> {
  return withConnectedPlatformSdk(network, async (sdk) => {
    const results: DpnsUsernameEntry[] = [];

    // Check sequentially to avoid rate limiting
    for (const entry of entries) {
      if (!entry.isValid) {
        results.push({ ...entry, status: 'invalid' });
        continue;
      }

      try {
        console.log(`Checking availability of "${entry.label}"...`);
        const isAvailable = await withRetry(
          () => sdk.dpns.isNameAvailable(entry.label),
          retryOptions
        );

        results.push({
          ...entry,
          isAvailable,
          status: isAvailable ? 'available' : 'taken',
        });
      } catch (error) {
        console.error(`Error checking ${entry.label}:`, error);
        // Assume taken on error to be safe
        results.push({
          ...entry,
          isAvailable: false,
          status: 'taken',
          validationError: error instanceof Error ? error.message : 'Check failed',
        });
      }
    }

    return results;
  }, retryOptions);
}

/**
 * Register a DPNS username
 */
export async function registerDpnsName(
  label: string,
  identityId: string,
  publicKeyId: number,
  privateKeyWif: string,
  network: string,
  onPreorder?: () => void,
  retryOptions?: RetryOptions
): Promise<{ success: boolean; isContested: boolean; error?: string }> {
  return withConnectedPlatformSdk(network, async (sdk) => {
    try {
      console.log(`Registering username "${label}" for identity ${identityId}...`);

      const identity = await fetchIdentityWithSdk(sdk, identityId, retryOptions);
      if (!identity) {
        throw new Error('Identity not found');
      }

      const identityKey = identity.getPublicKeyById(publicKeyId);
      if (!identityKey) {
        throw new Error(`Identity key ${publicKeyId} not found`);
      }

      const { IdentitySigner } = await loadSdkModule();
      const signer = new IdentitySigner();
      signer.addKeyFromWif(privateKeyWif);

      await withRetry(
        () => sdk.dpns.registerName({
          label,
          identity,
          identityKey,
          signer,
          preorderCallback: onPreorder ? () => onPreorder() : undefined,
        }),
        retryOptions
      );

      const normalized = convertToHomographSafe(label);
      return {
        success: true,
        isContested: isContestedUsername(normalized),
      };
    } catch (error) {
      console.error(`Failed to register "${label}":`, error);
      return {
        success: false,
        isContested: isContestedUsername(convertToHomographSafe(label)),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, retryOptions);
}

/**
 * Register multiple usernames sequentially
 */
export async function registerMultipleNames(
  entries: DpnsUsernameEntry[],
  identityId: string,
  publicKeyId: number,
  privateKeyWif: string,
  network: string,
  onProgress?: (current: number, total: number, label: string) => void
): Promise<DpnsRegistrationResult[]> {
  const results: DpnsRegistrationResult[] = [];

  // Filter to only available usernames
  const availableEntries = entries.filter((e) => e.isValid && e.isAvailable);

  for (let i = 0; i < availableEntries.length; i++) {
    const entry = availableEntries[i];
    onProgress?.(i + 1, availableEntries.length, entry.label);

    const result = await registerDpnsName(
      entry.label,
      identityId,
      publicKeyId,
      privateKeyWif,
      network
    );

    results.push({
      label: entry.label,
      success: result.success,
      error: result.error,
      isContested: entry.isContested ?? false,
    });
  }

  return results;
}

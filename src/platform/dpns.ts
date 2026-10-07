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
  identityKeyFromRecord,
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

  const result = keysArray.map(identityKeyFromRecord);
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

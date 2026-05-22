import { IdentitySigner } from '@dashevo/evo-sdk';
import type { DpnsUsernameEntry, DpnsRegistrationResult, IdentityPublicKeyInfo } from '../types.js';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import {
  fetchIdentityPublicKeyRecords,
  fetchIdentityWithSdk,
  withConnectedPlatformSdk,
} from './client.js';

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
 * Validate a DPNS label according to platform rules:
 * - 3-63 characters
 * - Alphanumeric first and last character
 * - Hyphens allowed in middle (no consecutive hyphens)
 * - Lowercase only (will be normalized)
 */
export function validateDpnsLabel(label: string): { isValid: boolean; error?: string } {
  if (!label) {
    return { isValid: false, error: 'Username is required' };
  }

  const normalized = label.toLowerCase();

  if (normalized.length < 3) {
    return { isValid: false, error: 'Minimum 3 characters' };
  }

  if (normalized.length > 63) {
    return { isValid: false, error: 'Maximum 63 characters' };
  }

  // Must start with alphanumeric
  if (!/^[a-z0-9]/.test(normalized)) {
    return { isValid: false, error: 'Must start with letter or number' };
  }

  // Must end with alphanumeric
  if (!/[a-z0-9]$/.test(normalized)) {
    return { isValid: false, error: 'Must end with letter or number' };
  }

  // Only alphanumeric and hyphens allowed
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    return { isValid: false, error: 'Only letters, numbers, and hyphens allowed' };
  }

  // No consecutive hyphens
  if (/--/.test(normalized)) {
    return { isValid: false, error: 'No consecutive hyphens allowed' };
  }

  return { isValid: true };
}

/**
 * Convert label to homograph-safe form
 * o -> 0, i -> 1, l -> 1
 */
export function convertToHomographSafe(label: string): string {
  return label
    .toLowerCase()
    .replace(/o/g, '0')
    .replace(/[il]/g, '1');
}

/**
 * Determine if a username is contested
 * Contested: 3-19 chars, only contains [a-z, 0, 1, -] after normalization
 * Non-contested: 20+ chars OR contains digits 2-9
 */
export function isContestedUsername(normalizedLabel: string): boolean {
  // 20+ chars is always non-contested
  if (normalizedLabel.length >= 20) {
    return false;
  }

  // Contains digits 2-9 is non-contested
  if (/[2-9]/.test(normalizedLabel)) {
    return false;
  }

  // 3-19 chars with only [a-z, 0, 1, -] is contested
  return /^[a-z01-]+$/.test(normalizedLabel);
}

/**
 * Create a validated username entry from a label
 */
export function createUsernameEntry(label: string): DpnsUsernameEntry {
  const normalized = convertToHomographSafe(label);
  const validation = validateDpnsLabel(label);

  return {
    label,
    normalizedLabel: normalized,
    isValid: validation.isValid,
    validationError: validation.error,
    isContested: validation.isValid ? isContestedUsername(normalized) : undefined,
    status: validation.isValid ? 'pending' : 'invalid',
  };
}

/**
 * Create an empty username entry
 */
export function createEmptyUsernameEntry(): DpnsUsernameEntry {
  return {
    label: '',
    normalizedLabel: '',
    isValid: false,
    status: 'pending',
  };
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

/**
 * Check if all available usernames in a list are contested
 * Used to determine if warning should be shown
 */
export function shouldShowContestedWarning(usernames: DpnsUsernameEntry[]): boolean {
  const validAvailable = usernames.filter((u) => u.isValid && u.isAvailable);

  // No valid available names - no warning needed
  if (validAvailable.length === 0) {
    return false;
  }

  // All valid+available names are contested
  return validAvailable.every((u) => u.isContested);
}

/**
 * Count of each username status category
 */
export function countUsernameStatuses(usernames: DpnsUsernameEntry[]): {
  available: number;
  taken: number;
  invalid: number;
  contested: number;
  nonContested: number;
} {
  const available = usernames.filter((u) => u.isValid && u.isAvailable).length;
  const taken = usernames.filter((u) => u.isValid && u.isAvailable === false).length;
  const invalid = usernames.filter((u) => !u.isValid).length;
  const contested = usernames.filter((u) => u.isValid && u.isAvailable && u.isContested).length;
  const nonContested = usernames.filter((u) => u.isValid && u.isAvailable && !u.isContested).length;

  return { available, taken, invalid, contested, nonContested };
}

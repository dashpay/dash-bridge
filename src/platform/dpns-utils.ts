import type { DpnsUsernameEntry, IdentityPublicKeyInfo } from '../types.js';
import type { PlatformIdentityKeyRecord } from './client.js';

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

  if (!/^[a-z0-9]/.test(normalized)) {
    return { isValid: false, error: 'Must start with letter or number' };
  }

  if (!/[a-z0-9]$/.test(normalized)) {
    return { isValid: false, error: 'Must end with letter or number' };
  }

  if (!/^[a-z0-9-]+$/.test(normalized)) {
    return { isValid: false, error: 'Only letters, numbers, and hyphens allowed' };
  }

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
 * Determine if a username is contested.
 */
export function isContestedUsername(normalizedLabel: string): boolean {
  if (normalizedLabel.length >= 20) {
    return false;
  }

  if (/[2-9]/.test(normalizedLabel)) {
    return false;
  }

  return /^[a-z01-]+$/.test(normalizedLabel);
}

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

export function createEmptyUsernameEntry(): DpnsUsernameEntry {
  return {
    label: '',
    normalizedLabel: '',
    isValid: false,
    status: 'pending',
  };
}

export function shouldShowContestedWarning(usernames: DpnsUsernameEntry[]): boolean {
  const validAvailable = usernames.filter((u) => u.isValid && u.isAvailable);

  if (validAvailable.length === 0) {
    return false;
  }

  return validAvailable.every((u) => u.isContested);
}

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

const KEY_TYPES: Record<string, number> = { ECDSA_SECP256K1: 0, ECDSA_HASH160: 2 };
const KEY_PURPOSES: Record<string, number> = {
  AUTHENTICATION: 0, ENCRYPTION: 1, DECRYPTION: 2, TRANSFER: 3, OWNER: 4, VOTING: 5,
};
const SECURITY_LEVELS: Record<string, number> = { MASTER: 0, CRITICAL: 1, HIGH: 2, MEDIUM: 3 };

/**
 * Convert an SDK key record (`IdentityPublicKey` getters: string enums, hex
 * `data`) to our numeric form.
 *
 * Unknown or missing enum strings keep their historical fallbacks (type and
 * purpose 0, level MASTER) for the existing flows, but set `unrecognized` so
 * callers that must fail closed (Sign in with Dash) can refuse the key.
 */
export function identityKeyFromRecord(key: PlatformIdentityKeyRecord): IdentityPublicKeyInfo {
  const known = (map: Record<string, number>, value: unknown) =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(map, value);

  const rawData = key.data;
  let data: Uint8Array;
  if (typeof rawData === 'string' && /^[0-9a-fA-F]+$/.test(rawData)) {
    data = new Uint8Array(rawData.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
  } else if (typeof rawData === 'string') {
    data = new Uint8Array(atob(rawData).split('').map((c) => c.charCodeAt(0)));
  } else {
    console.warn('Unexpected key data format:', rawData);
    data = new Uint8Array(0);
  }

  return {
    id: key.keyId,
    type: KEY_TYPES[key.keyType ?? 'ECDSA_SECP256K1'] ?? 0,
    purpose: KEY_PURPOSES[key.purpose ?? 'AUTHENTICATION'] ?? 0,
    securityLevel: SECURITY_LEVELS[key.securityLevel ?? 'MASTER'] ?? 0,
    data,
    // The SDK reports a disabled key with a disabledAt timestamp.
    isDisabled: key.disabledAt !== undefined && key.disabledAt !== null,
    // `contractBounds` getter (undefined) or toJSON() (null) when unbound.
    isContractBound: key.contractBounds !== undefined && key.contractBounds !== null,
    unrecognized:
      !known(KEY_TYPES, key.keyType) || !known(KEY_PURPOSES, key.purpose) || !known(SECURITY_LEVELS, key.securityLevel),
  };
}

import type { DpnsUsernameEntry } from '../types.js';

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

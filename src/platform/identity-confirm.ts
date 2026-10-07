/**
 * Pure helpers for confirming that an identity create transition really
 * landed after Platform answered a resubmission with "already exists".
 *
 * Kept free of SDK imports so the UI layer can recognise the error class by
 * name and so the decision logic is unit-testable without the wasm SDK.
 */

/** `Error.name` of {@link IdentityRegistrationUnconfirmedError}. */
export const IDENTITY_REGISTRATION_UNCONFIRMED = 'IdentityRegistrationUnconfirmedError';

/**
 * Platform acknowledged the identity create transition (it is at least in
 * Tenderdash's mempool cache) but the identity could not be fetched within
 * the confirmation window. Retrying is safe: the identity ID is derived from
 * the asset lock outpoint and the asset lock can only be consumed once.
 */
export class IdentityRegistrationUnconfirmedError extends Error {
  readonly identityId: string;

  constructor(identityId: string, detail?: string) {
    super(
      `Identity registration was submitted, but Platform has not confirmed it yet (identity ID ${identityId}). ` +
        'Your deposit is safe: it can only be used once and the identity ID is fixed, so retrying cannot create ' +
        'a second identity or spend the deposit twice. Keep your key backup, wait a minute, then retry the registration.' +
        (detail ? ` (Last lookup: ${detail})` : '')
    );
    this.name = IDENTITY_REGISTRATION_UNCONFIRMED;
    this.identityId = identityId;
  }
}

export function isIdentityRegistrationUnconfirmedError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === IDENTITY_REGISTRATION_UNCONFIRMED;
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Matches the "already submitted" family of Platform errors: the transition
 * was committed earlier ("Object already exists" / AlreadyExists) or is still
 * sitting in the mempool cache ("tx already exists in cache"). None of these
 * prove the identity exists — callers must confirm by fetching it.
 */
export function isAlreadyExistsError(error: unknown): boolean {
  const msg = errorText(error);
  return (
    msg.includes('Object already exists') ||
    msg.includes('tx already exists in cache') ||
    msg.includes('AlreadyExists')
  );
}

/**
 * True when a lookup failed because the client could not reach (or has no
 * usable) Platform nodes, as opposed to Platform answering "not found".
 */
export function isTransportUnavailableError(error: unknown): boolean {
  const msg = errorText(error).toLowerCase();
  return (
    msg.includes('transportnoavailableaddresses') ||
    msg.includes('no available addresses') ||
    msg.includes('transport') ||
    msg.includes('unavailable') ||
    msg.includes('failed to fetch') ||
    msg.includes('connection') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset')
  );
}

/** Some SDK lookups (e.g. fetchUnproved) throw instead of returning undefined. */
export function isIdentityNotFoundError(error: unknown): boolean {
  return errorText(error).toLowerCase().includes('not found');
}

export interface IdentityLookupSummary<T> {
  identity?: T;
  attempts: number;
  /** Lookups where Platform answered and the identity did not exist. */
  notFound: number;
  /** Lookups that failed (no answer either way). */
  errors: unknown[];
}

/**
 * Poll `lookup` until it returns an identity or `timeoutMs` elapses. A
 * nullish result (or a "not found" error) counts as a definitive miss; any
 * other error is recorded and polling continues.
 */
export async function pollForIdentity<T>(
  lookup: () => Promise<T | null | undefined>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<IdentityLookupSummary<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + options.timeoutMs;
  const summary: IdentityLookupSummary<T> = { attempts: 0, notFound: 0, errors: [] };

  for (;;) {
    summary.attempts++;
    try {
      const identity = await lookup();
      if (identity) {
        summary.identity = identity;
        return summary;
      }
      summary.notFound++;
    } catch (error) {
      if (isIdentityNotFoundError(error)) {
        summary.notFound++;
      } else {
        summary.errors.push(error);
      }
    }
    if (now() + options.intervalMs > deadline) return summary;
    await sleep(options.intervalMs);
  }
}

/**
 * Decide whether an unconfirmed "already exists" may still be reported as
 * success. Only on devnets, and only when EVERY lookup failed with a
 * transport/unavailability error — i.e. we never got an answer from Platform
 * at all. A single definitive "not found", or any failure on
 * mainnet/testnet, means the outcome stays unconfirmed.
 */
export function allowUnverifiedDevnetFallback(
  networkType: string,
  summary: IdentityLookupSummary<unknown>
): boolean {
  return (
    networkType === 'devnet' &&
    !summary.identity &&
    summary.notFound === 0 &&
    summary.errors.length > 0 &&
    summary.errors.every(isTransportUnavailableError)
  );
}

function hexToBytesOrNull(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function base64ToBytesOrNull(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compare SDK public key data to expected bytes. The SDK exposes `data` as a
 * string whose encoding isn't pinned by its typings (hex in practice, base64
 * in some JSON forms), so accept either — plus raw bytes.
 */
export function publicKeyDataMatches(actual: unknown, expected: Uint8Array): boolean {
  if (actual instanceof Uint8Array) return bytesEqual(actual, expected);
  if (typeof actual !== 'string') return false;
  const candidates = [hexToBytesOrNull(actual), base64ToBytesOrNull(actual)];
  return candidates.some((bytes) => bytes !== null && bytesEqual(bytes, expected));
}

/**
 * Return the IDs of expected keys that are missing from the fetched identity
 * (no key with the same ID and the same public key data).
 */
export function findMissingIdentityKeys(
  expected: ReadonlyArray<{ id: number; data: Uint8Array }>,
  actual: ReadonlyArray<{ keyId: number; data: unknown }>
): number[] {
  return expected
    .filter((key) => !actual.some((a) => a.keyId === key.id && publicKeyDataMatches(a.data, key.data)))
    .map((key) => key.id);
}

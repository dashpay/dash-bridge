/**
 * Server-side verifier for "Sign in with Dash" results (docs/widget.md).
 *
 * Built as `dist/widget-verify.mjs` (ES module, no imports). Works in Node 18+
 * and browsers. Not part of `widget.js`: verification belongs on your server.
 */
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { recoverDashMessageSigner } from '../crypto/message-signing.js';
import {
  LOGIN_CLOCK_SKEW_MS,
  LOGIN_TTL_MS,
  buildLoginMessage,
  extractLoginOrigin,
  extractLoginStatement,
  isLoginTime,
  pickLoginResult,
  type LoginResult,
} from '../embed/login.js';

export type { LoginResult };
export { LOGIN_TTL_MS, LOGIN_CLOCK_SKEW_MS };

/**
 * An identity public key as Platform returns it. Accepted shapes:
 * - `identity.toJSON().publicKeys` from `@dashevo/evo-sdk` (`data` is base64)
 * - `IdentityPublicKey` objects from `sdk.identities.getKeys(...)` or
 *   `identity.publicKeys` (`keyId`, `keyType`, string enums, `data` hex)
 * - plain objects with numeric enums and `data` as Uint8Array, number[], hex or base64
 */
export interface VerifierPublicKey {
  id?: number;
  keyId?: number;
  /** 0 / `'ECDSA_SECP256K1'` or 2 / `'ECDSA_HASH160'`. Other key types never verify. */
  type?: number | string;
  keyType?: number | string;
  /** 0 / `'AUTHENTICATION'` is required. */
  purpose: number | string;
  /** 1 / `'CRITICAL'` or 2 / `'HIGH'` is required. */
  securityLevel: number | string;
  data: Uint8Array | readonly number[] | string;
  /** Set (non-null) when the key is disabled. */
  disabledAt?: number | bigint | string | null;
  isDisabled?: boolean;
}

export interface VerifyLoginOptions {
  /** Your app's origin, exactly as the user's browser sees it, e.g. `https://app.example`. */
  expectedOrigin: string;
  /** The nonce your server issued for this login attempt. Accept each nonce once. */
  expectedNonce: string;
  /** `'mainnet'` or `'testnet'`: the network you fetched the identity from. */
  network: string;
  /** The identity's public keys, fetched from Platform by your server (never from the client). */
  identityPublicKeys: readonly VerifierPublicKey[];
  /** If set, the message must carry exactly this statement. */
  expectedStatement?: string;
  /** Defaults to the current time. */
  now?: Date | number;
}

export type VerifyLoginFailure =
  | 'malformed'
  | 'nonce_mismatch'
  | 'network_mismatch'
  | 'origin_mismatch'
  | 'statement_mismatch'
  | 'message_mismatch'
  | 'not_yet_valid'
  | 'expired'
  | 'key_not_found'
  | 'key_disabled'
  | 'wrong_key_purpose'
  | 'wrong_security_level'
  | 'unsupported_key_type'
  | 'invalid_signature';

export type VerifyLoginResult =
  | { ok: true; identityId: string; keyId: number }
  | { ok: false; reason: VerifyLoginFailure };

const KEY_TYPES: Record<string, number> = { ECDSA_SECP256K1: 0, ECDSA_HASH160: 2 };
const PURPOSES: Record<string, number> = { AUTHENTICATION: 0 };
const SECURITY_LEVELS: Record<string, number> = { MASTER: 0, CRITICAL: 1, HIGH: 2, MEDIUM: 3 };
const KEY_TYPE_SECP256K1 = 0;
const KEY_TYPE_HASH160 = 2;
const PURPOSE_AUTHENTICATION = 0;
const ALLOWED_SECURITY_LEVELS = [1, 2];

function enumValue(value: unknown, names: Record<string, number>): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return names[value];
  return undefined;
}

/** Key data as bytes. Strings are hex when they have the expected hex length, else base64. */
function keyBytes(data: VerifierPublicKey['data'], expectedLength: number): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (typeof data !== 'string') return null;
  if (data.length === expectedLength * 2 && /^[0-9a-fA-F]+$/.test(data)) {
    return Uint8Array.from(data.match(/../g)!, (h) => parseInt(h, 16));
  }
  try {
    return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function fail(reason: VerifyLoginFailure): VerifyLoginResult {
  return { ok: false, reason };
}

/**
 * Verify a login result from `DashBridge.login()` / `parseLoginRedirect()`.
 * `ok: true` means the holder of an enabled CRITICAL or HIGH AUTHENTICATION
 * key of `identityId` signed in to `expectedOrigin` with `expectedNonce`.
 *
 * You still have to mark the nonce as used, and pass keys that your server
 * fetched from Platform for `result.identityId` on `network`.
 */
export function verifyLogin(result: unknown, options: VerifyLoginOptions): VerifyLoginResult {
  const login = pickLoginResult(result);
  if (!login || !isLoginTime(login.issuedAt) || !isLoginTime(login.expiresAt)) return fail('malformed');

  if (login.nonce !== options.expectedNonce) return fail('nonce_mismatch');
  if (login.network !== options.network) return fail('network_mismatch');
  if (extractLoginOrigin(login.message) !== options.expectedOrigin) return fail('origin_mismatch');
  const statement = extractLoginStatement(login.message);
  if (options.expectedStatement !== undefined && statement !== options.expectedStatement) {
    return fail('statement_mismatch');
  }

  let rebuilt: string;
  try {
    rebuilt = buildLoginMessage({
      origin: options.expectedOrigin,
      identityId: login.identityId,
      statement,
      network: options.network,
      keyId: login.keyId,
      nonce: options.expectedNonce,
      issuedAt: login.issuedAt,
      expiresAt: login.expiresAt,
    });
  } catch {
    return fail('message_mismatch');
  }
  if (rebuilt !== login.message) return fail('message_mismatch');

  const issuedMs = Date.parse(login.issuedAt);
  const expiresMs = Date.parse(login.expiresAt);
  if (expiresMs <= issuedMs || expiresMs - issuedMs > LOGIN_TTL_MS) return fail('malformed');
  const now = options.now === undefined ? Date.now() : Number(options.now);
  if (issuedMs > now + LOGIN_CLOCK_SKEW_MS) return fail('not_yet_valid');
  if (now >= expiresMs) return fail('expired');

  const key = options.identityPublicKeys.find((k) => (k.id ?? k.keyId) === login.keyId);
  if (!key) return fail('key_not_found');
  if (key.isDisabled || (key.disabledAt !== undefined && key.disabledAt !== null)) return fail('key_disabled');
  if (enumValue(key.purpose, PURPOSES) !== PURPOSE_AUTHENTICATION) return fail('wrong_key_purpose');
  const level = enumValue(key.securityLevel, SECURITY_LEVELS);
  if (level === undefined || !ALLOWED_SECURITY_LEVELS.includes(level)) return fail('wrong_security_level');

  const type = enumValue(key.type ?? key.keyType, KEY_TYPES);
  if (type !== KEY_TYPE_SECP256K1 && type !== KEY_TYPE_HASH160) return fail('unsupported_key_type');
  const expected = keyBytes(key.data, type === KEY_TYPE_SECP256K1 ? 33 : 20);
  const signer = recoverDashMessageSigner(login.message, login.signature);
  if (!expected || !signer) return fail('invalid_signature');
  const signerData = type === KEY_TYPE_SECP256K1 ? signer : ripemd160(sha256(signer));
  if (!bytesEqual(signerData, expected)) return fail('invalid_signature');

  return { ok: true, identityId: login.identityId, keyId: login.keyId };
}

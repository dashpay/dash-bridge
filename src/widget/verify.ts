/**
 * Server-side verifier for "Sign in with Dash" results (docs/widget.md).
 *
 * Built as `dist/widget-verify.mjs` (ES module, no imports). Works in Node 18+
 * and browsers. Not part of `widget.js`: verification belongs on your server.
 */
import { recoverDashMessageSigner } from '../crypto/message-signing.js';
import { hash160 } from '../crypto/hash.js';
import { bytesEqual, hexToBytes } from '../utils/hex.js';
import { base64ToBytes } from '../utils/base64.js';
import {
  LOGIN_CLOCK_SKEW_MS,
  LOGIN_TTL_MS,
  buildLoginMessage,
  isLoginTime,
  parseLoginMessage,
  parseReturnUrl,
  pickLoginResult,
  sanitizeStatement,
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
  /** Set (non-null) when the key may only be used with one contract. Such keys never verify. */
  contractBounds?: unknown;
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
  /**
   * Redirect-mode apps: the callback URL you send users back to (the
   * `returnUrl` you passed to `loginRedirectUrl`, absolute). A redirect proof
   * is only accepted with a matching value, and a popup proof is refused when
   * this is set. Popup-only apps must leave it out, so they never accept a
   * redirect proof.
   */
  expectedReturnUrl?: string;
  /** If set, the message must carry this statement (compared after the bridge's sanitizing). */
  expectedStatement?: string;
  /** Defaults to the current time. Must be a valid time. */
  now?: Date | number;
}

export type VerifyLoginFailure =
  /** `options.now` is not a valid time. */
  | 'invalid_options'
  | 'malformed'
  | 'nonce_mismatch'
  | 'network_mismatch'
  | 'origin_mismatch'
  | 'statement_mismatch'
  | 'return_url_mismatch'
  | 'message_mismatch'
  | 'not_yet_valid'
  | 'expired'
  | 'key_not_found'
  | 'key_disabled'
  | 'key_contract_bound'
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
  if (data.length === expectedLength * 2 && /^[0-9a-fA-F]+$/.test(data)) return hexToBytes(data);
  try {
    return base64ToBytes(data);
  } catch {
    return null;
  }
}

const isSet = (value: unknown) => value !== undefined && value !== null;

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
  // A NaN clock would make every time comparison below false, i.e. pass.
  const now = options.now === undefined ? Date.now() : Number(options.now);
  if (!Number.isFinite(now)) return fail('invalid_options');

  const login = pickLoginResult(result);
  if (!login || !isLoginTime(login.issuedAt) || !isLoginTime(login.expiresAt)) return fail('malformed');

  if (login.nonce !== options.expectedNonce) return fail('nonce_mismatch');
  if (login.network !== options.network) return fail('network_mismatch');
  const parsed = parseLoginMessage(login.message);
  if (!parsed || parsed.origin !== options.expectedOrigin) return fail('origin_mismatch');
  const { statement, returnUrl } = parsed;
  if (options.expectedStatement !== undefined && statement !== sanitizeStatement(options.expectedStatement)) {
    return fail('statement_mismatch');
  }
  // Bind the proof to how it was delivered: a redirect proof only to the
  // callback the app expects, and never a redirect proof to a popup-only app
  // (or a popup proof to a redirect app).
  if (returnUrl !== undefined || options.expectedReturnUrl !== undefined) {
    const expected =
      options.expectedReturnUrl === undefined ? undefined : parseReturnUrl(options.expectedReturnUrl, options.expectedOrigin);
    if (!expected || returnUrl !== expected) return fail('return_url_mismatch');
  }

  let rebuilt: string;
  try {
    rebuilt = buildLoginMessage({
      origin: options.expectedOrigin,
      returnUrl,
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
  if (issuedMs > now + LOGIN_CLOCK_SKEW_MS) return fail('not_yet_valid');
  if (now >= expiresMs) return fail('expired');

  const key = options.identityPublicKeys.find((k) => (k.id ?? k.keyId) === login.keyId);
  if (!key) return fail('key_not_found');
  if (key.isDisabled || isSet(key.disabledAt)) return fail('key_disabled');
  if (isSet(key.contractBounds)) return fail('key_contract_bound');
  if (enumValue(key.purpose, PURPOSES) !== PURPOSE_AUTHENTICATION) return fail('wrong_key_purpose');
  const level = enumValue(key.securityLevel, SECURITY_LEVELS);
  if (level === undefined || !ALLOWED_SECURITY_LEVELS.includes(level)) return fail('wrong_security_level');

  const type = enumValue(key.type ?? key.keyType, KEY_TYPES);
  if (type !== KEY_TYPE_SECP256K1 && type !== KEY_TYPE_HASH160) return fail('unsupported_key_type');
  const expected = keyBytes(key.data, type === KEY_TYPE_SECP256K1 ? 33 : 20);
  const signer = recoverDashMessageSigner(login.message, login.signature);
  if (!expected || !signer) return fail('invalid_signature');
  const signerData = type === KEY_TYPE_SECP256K1 ? signer : hash160(signer);
  if (!bytesEqual(signerData, expected)) return fail('invalid_signature');

  return { ok: true, identityId: login.identityId, keyId: login.keyId };
}

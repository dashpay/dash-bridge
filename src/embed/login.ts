/**
 * "Sign in with Dash": the message format and result encoding shared by the
 * bridge, the widget SDK and the verifier (`widget-verify.mjs`).
 *
 * The bridge signs the message built here, and the verifier rebuilds it from
 * the result fields and the app's own expectations, so the two can never
 * disagree about what was signed. Keep this module dependency-free: the SDK
 * and the verifier both bundle it.
 */

/** Lifetime of a login proof: `expiresAt = issuedAt + LOGIN_TTL_MS`. */
export const LOGIN_TTL_MS = 10 * 60 * 1000;
/** Clock skew the verifier tolerates for an `issuedAt` in the future. */
export const LOGIN_CLOCK_SKEW_MS = 60 * 1000;
export const MAX_STATEMENT_LENGTH = 140;

/** URL fragment parameters used in redirect mode. */
export const LOGIN_REDIRECT_PARAM = 'dash_login';
export const LOGIN_REDIRECT_ERROR_PARAM = 'dash_login_error';
const MAX_RETURN_URL_LENGTH = 2048;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const IDENTITY_ID_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NETWORK_PATTERN = /^[a-z0-9-]{1,32}$/;
/** `YYYY-MM-DDTHH:mm:ssZ`: ISO-8601 UTC, whole seconds. */
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;

/** What the app receives after the user signs in. Contains no secrets. */
export interface LoginResult {
  identityId: string;
  /** ID of the identity key that signed `message`. */
  keyId: number;
  network: string;
  /** The exact text that was signed. */
  message: string;
  /** Dash signed-message signature: base64 of a 65-byte compact recoverable signature. */
  signature: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export const LOGIN_RESULT_FIELDS = [
  'identityId',
  'keyId',
  'network',
  'message',
  'signature',
  'nonce',
  'issuedAt',
  'expiresAt',
] as const satisfies readonly (keyof LoginResult)[];

/** Everything the signed message commits to. */
export interface LoginMessageFields {
  /** Origin of the app the user signs in to, e.g. `https://app.example`. */
  origin: string;
  identityId: string;
  statement?: string;
  network: string;
  keyId: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export function isValidNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE_PATTERN.test(value);
}

export function isLoginTime(value: unknown): value is string {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && formatLoginTime(ms) === value;
}

/** Format a time as used in login messages (UTC, whole seconds). */
export function formatLoginTime(time: Date | number): string {
  const ms = typeof time === 'number' ? time : time.getTime();
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** `issuedAt` / `expiresAt` for a login signed at `now`. */
export function loginValidity(now: Date | number = Date.now()): { issuedAt: string; expiresAt: string } {
  const issuedMs = Date.parse(formatLoginTime(now));
  return { issuedAt: formatLoginTime(issuedMs), expiresAt: formatLoginTime(issuedMs + LOGIN_TTL_MS) };
}

/**
 * Trim, drop control and format characters (newlines, bidi overrides) and cap
 * the length of the app-supplied statement, counting code points.
 */
export function sanitizeStatement(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const stripped = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const cleaned = Array.from(stripped).slice(0, MAX_STATEMENT_LENGTH).join('').trim();
  return cleaned || undefined;
}

function hostOf(origin: string): string {
  const url = new URL(origin);
  if (url.origin !== origin) throw new Error('origin must be a bare web origin');
  return url.host;
}

/**
 * Build the text the user signs. Deterministic: the same fields always give
 * the same bytes. Lines are joined with `\n`, with no trailing newline:
 *
 * ```
 * <host> wants you to sign in with your Dash Platform identity:
 * <identityId>
 *
 * <statement>            (this line and the blank line after it only if set)
 *
 * URI: <origin>
 * Network: <network>
 * Key ID: <keyId>
 * Nonce: <nonce>
 * Issued At: <issuedAt>
 * Expiration Time: <expiresAt>
 * ```
 *
 * Throws if a field is malformed, so nothing ambiguous is ever signed.
 */
export function buildLoginMessage(fields: LoginMessageFields): string {
  const host = hostOf(fields.origin);
  if (!IDENTITY_ID_PATTERN.test(fields.identityId)) throw new Error('invalid identity ID');
  if (!NETWORK_PATTERN.test(fields.network)) throw new Error('invalid network');
  if (!Number.isSafeInteger(fields.keyId) || fields.keyId < 0) throw new Error('invalid key ID');
  if (!isValidNonce(fields.nonce)) throw new Error('invalid nonce');
  if (!isLoginTime(fields.issuedAt) || !isLoginTime(fields.expiresAt)) throw new Error('invalid time');
  if (fields.statement && sanitizeStatement(fields.statement) !== fields.statement) {
    throw new Error('invalid statement');
  }

  const lines = [`${host} wants you to sign in with your Dash Platform identity:`, fields.identityId, ''];
  if (fields.statement) lines.push(fields.statement, '');
  lines.push(
    `URI: ${fields.origin}`,
    `Network: ${fields.network}`,
    `Key ID: ${fields.keyId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expiration Time: ${fields.expiresAt}`,
  );
  return lines.join('\n');
}

/** Lines of a message without / with a statement (layout of buildLoginMessage). */
const LINES_WITHOUT_STATEMENT = 9;
const LINES_WITH_STATEMENT = 11;

/** The statement line of a login message, if it has one. */
export function extractLoginStatement(message: string): string | undefined {
  const lines = message.split('\n');
  return lines.length === LINES_WITH_STATEMENT && lines[2] === '' && lines[4] === '' ? lines[3] : undefined;
}

/** The origin on the `URI:` line of a login message. */
export function extractLoginOrigin(message: string): string | undefined {
  const lines = message.split('\n');
  if (lines.length !== LINES_WITHOUT_STATEMENT && lines.length !== LINES_WITH_STATEMENT) return undefined;
  const line = lines[lines.length - 6];
  return line.startsWith('URI: ') ? line.slice('URI: '.length) : undefined;
}

/**
 * Copy only the known result fields, checking their types. Returns null for
 * anything that isn't a well-formed result.
 */
export function pickLoginResult(value: unknown): LoginResult | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const strings = ['identityId', 'network', 'message', 'signature', 'nonce', 'issuedAt', 'expiresAt'] as const;
  if (!strings.every((field) => typeof v[field] === 'string')) return null;
  if (typeof v.keyId !== 'number' || !Number.isSafeInteger(v.keyId) || v.keyId < 0) return null;
  const result = {} as Record<string, unknown>;
  for (const field of LOGIN_RESULT_FIELDS) result[field] = v[field];
  return result as unknown as LoginResult;
}

/**
 * Validate a redirect-mode `returnUrl`: an absolute https URL (http only on
 * loopback) on exactly `origin`, without credentials.
 */
export function parseReturnUrl(value: string | null | undefined, origin: string): string | null {
  if (!value || value.length > MAX_RETURN_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  return url.href;
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('invalid base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/**
 * Redirect mode: `returnUrl` with the outcome in the fragment, which browsers
 * never send to servers. Any fragment already on `returnUrl` is replaced.
 */
export function buildLoginRedirectUrl(returnUrl: string, outcome: LoginResult | { error: string }): string {
  const url = new URL(returnUrl);
  const params = new URLSearchParams();
  if ('error' in outcome) {
    params.set(LOGIN_REDIRECT_ERROR_PARAM, outcome.error);
  } else {
    const result = pickLoginResult(outcome);
    if (!result) throw new Error('invalid login result');
    params.set(LOGIN_REDIRECT_PARAM, base64UrlEncode(JSON.stringify(result)));
  }
  url.hash = params.toString();
  return url.href;
}

/**
 * Read a redirect-mode outcome from a URL fragment. Returns null when the
 * fragment holds no login outcome. Shape-checks only: verify the result on
 * your server.
 */
export function parseLoginFragment(hash: string): LoginResult | { error: string } | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const error = params.get(LOGIN_REDIRECT_ERROR_PARAM);
  if (error !== null) return { error: ERROR_CODE_PATTERN.test(error) ? error : 'invalid_response' };
  const encoded = params.get(LOGIN_REDIRECT_PARAM);
  if (encoded === null) return null;
  try {
    return pickLoginResult(JSON.parse(base64UrlDecode(encoded))) ?? { error: 'invalid_response' };
  } catch {
    return { error: 'invalid_response' };
  }
}

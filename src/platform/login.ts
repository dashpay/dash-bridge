/**
 * Bridge side of "Sign in with Dash": check that a WIF belongs to an identity
 * key that may sign in, and sign the login message with it.
 */
import type { IdentityPublicKeyInfo, LoginKeyInfo } from '../types.js';
import {
  findMatchingKeyIndex,
  getPurposeName,
  getSecurityLevelName,
  isPurposeAllowedForDpns,
  isSecurityLevelAllowedForDpns,
} from '../crypto/keys.js';
import { signDashMessage } from '../crypto/message-signing.js';
import { wifToPrivateKey } from '../utils/wif.js';
import { getNetwork } from '../config.js';
import { buildLoginMessage, loginValidity, type LoginResult } from '../embed/login.js';
import { isIdentityNotFoundError } from './identity-confirm.js';

const SECURITY_LEVEL_MASTER = 0;

export const MASTER_KEY_REFUSED =
  'Use a HIGH or CRITICAL authentication key; never paste your MASTER key into a login.';

/** Why `privateKeyWif` can't be a key on `network`, or null if it can. */
export function validateLoginWif(privateKeyWif: string, network: string): string | null {
  if (!privateKeyWif) return 'Enter the private key (WIF) of one of your identity keys.';
  let prefix: number;
  try {
    prefix = wifToPrivateKey(privateKeyWif).prefix;
  } catch {
    return 'This is not a valid private key in WIF format.';
  }
  return prefix === getNetwork(network).wifPrefix ? null : `This private key is not for ${network}.`;
}

export type LoginKeyCheck = { ok: true; key: LoginKeyInfo } | { ok: false; error: string };

/**
 * Find the identity key `privateKeyWif` controls and check it may sign in:
 * enabled, AUTHENTICATION purpose, CRITICAL or HIGH security level.
 */
export function checkLoginKey(
  privateKeyWif: string,
  identityKeys: IdentityPublicKeyInfo[],
  network: string
): LoginKeyCheck {
  const refuse = (error: string): LoginKeyCheck => ({ ok: false, error });
  const formatError = validateLoginWif(privateKeyWif, network);
  if (formatError) return refuse(formatError);

  const match = findMatchingKeyIndex(privateKeyWif, identityKeys.filter((k) => !k.isDisabled), network);
  if (!match) {
    return findMatchingKeyIndex(privateKeyWif, identityKeys, network)
      ? refuse('This key is disabled on the identity. Use another authentication key.')
      : refuse('This key does not belong to this identity.');
  }
  if (!isPurposeAllowedForDpns(match.purpose)) {
    return refuse(
      `This key has ${getPurposeName(match.purpose)} purpose. Sign in with an AUTHENTICATION key (HIGH or CRITICAL).`
    );
  }
  if (match.securityLevel === SECURITY_LEVEL_MASTER) return refuse(MASTER_KEY_REFUSED);
  if (!isSecurityLevelAllowedForDpns(match.securityLevel)) {
    return refuse(
      `This key has ${getSecurityLevelName(match.securityLevel)} security level. Use a HIGH or CRITICAL authentication key.`
    );
  }
  const type = identityKeys.find((k) => k.id === match.keyId)?.type ?? 0;
  return { ok: true, key: { keyId: match.keyId, securityLevel: match.securityLevel, type } };
}

/** User-facing reason an identity's keys could not be fetched. */
export function describeLoginFetchError(error: unknown, network: string): string {
  const message = error instanceof Error ? error.message : String(error);
  // A key lookup for an unknown identity may come back empty rather than fail.
  if (isIdentityNotFoundError(error) || message === 'Identity has no keys') {
    return `Identity not found on ${network}. Check the identity ID and network.`;
  }
  return `Could not reach Dash Platform: ${message}. Check your connection and try again.`;
}

export interface SignLoginParams {
  origin: string;
  identityId: string;
  statement?: string;
  network: string;
  nonce: string;
  keyId: number;
  privateKeyWif: string;
  now?: Date | number;
}

/** Build and sign the login message. The result carries no private material. */
export async function signLogin(params: SignLoginParams): Promise<LoginResult> {
  const { issuedAt, expiresAt } = loginValidity(params.now);
  const message = buildLoginMessage({
    origin: params.origin,
    identityId: params.identityId,
    statement: params.statement,
    network: params.network,
    keyId: params.keyId,
    nonce: params.nonce,
    issuedAt,
    expiresAt,
  });
  const signature = await signDashMessage(message, wifToPrivateKey(params.privateKeyWif).privateKey);
  return {
    identityId: params.identityId,
    keyId: params.keyId,
    network: params.network,
    message,
    signature,
    nonce: params.nonce,
    issuedAt,
    expiresAt,
  };
}

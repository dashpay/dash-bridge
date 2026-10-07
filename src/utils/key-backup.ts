import { isWellFormedIdentityId } from '../platform/username-transfer-utils.js';
import { wifToPrivateKey } from './wif.js';

export interface ParsedKeyBackup {
  identityId: string;
  privateKeyWif: string;
  purpose: string;
  securityLevel: string;
}

const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** A Base58Check-encoded private key with a valid checksum and length. */
function isWellFormedWif(wif: string): boolean {
  if (!BASE58_PATTERN.test(wif)) return false;
  try {
    wifToPrivateKey(wif);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a key backup JSON file and extract identityId + best private key WIF.
 * Prefers AUTHENTICATION keys with HIGH or CRITICAL security level, since those
 * are required for DPNS and contract operations. MASTER keys are ranked lower
 * because they are rejected by isPurposeAllowedForDpns/isSecurityLevelAllowedForDpns.
 *
 * The file is untrusted input whose fields end up in the rendered page, so only
 * a well-formed identity ID and checksum-valid WIFs are accepted. Anything else yields
 * null (or, for individual keys, is skipped).
 */
export function parseKeyBackup(json: unknown, preferredPurpose?: string): ParsedKeyBackup | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const rawIdentityId = obj.identityId || obj.targetIdentityId;
  if (typeof rawIdentityId !== 'string') return null;
  const identityId = rawIdentityId.trim();
  if (!isWellFormedIdentityId(identityId)) return null;

  const keys = obj.identityKeys;
  if (!Array.isArray(keys) || keys.length === 0) return null;

  const ranked = keys
    .filter((k): k is Record<string, unknown> => !!k && typeof k === 'object' && typeof k.privateKeyWif === 'string')
    .map((k) => ({ purpose: k.purpose, securityLevel: k.securityLevel, privateKeyWif: (k.privateKeyWif as string).trim() }))
    .filter((k) => isWellFormedWif(k.privateKeyWif))
    .sort((a, b) => {
      // Caller-preferred purpose wins outright (e.g. TRANSFER for withdrawals)
      if (preferredPurpose) {
        const aPref = a.purpose === preferredPurpose ? 1 : 0;
        const bPref = b.purpose === preferredPurpose ? 1 : 0;
        if (aPref !== bPref) return bPref - aPref;
      }
      // Prefer AUTHENTICATION purpose
      const aAuth = a.purpose === 'AUTHENTICATION' ? 1 : 0;
      const bAuth = b.purpose === 'AUTHENTICATION' ? 1 : 0;
      if (aAuth !== bAuth) return bAuth - aAuth;
      // Prefer HIGH/CRITICAL over MASTER (MASTER is not accepted for DPNS/contracts)
      const levelOrder: Record<string, number> = { HIGH: 4, CRITICAL: 3, MEDIUM: 2, MASTER: 1 };
      return (levelOrder[b.securityLevel as string] || 0) - (levelOrder[a.securityLevel as string] || 0);
    });

  if (ranked.length === 0) return null;
  const best = ranked[0];
  return {
    identityId,
    privateKeyWif: best.privateKeyWif,
    purpose: typeof best.purpose === 'string' && best.purpose ? best.purpose : 'UNKNOWN',
    securityLevel: typeof best.securityLevel === 'string' && best.securityLevel ? best.securityLevel : 'UNKNOWN',
  };
}

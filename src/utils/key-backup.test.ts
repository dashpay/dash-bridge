import { describe, it, expect } from 'vitest';
import { parseKeyBackup } from './key-backup.js';
import { createKeyBackup } from '../ui/components.js';
import { createInitialState } from '../ui/state.js';
import { generateKeyPair } from '../crypto/keys.js';
import { privateKeyToWif } from './wif.js';
import { bytesToHex } from './hex.js';
import { TESTNET } from '../config.js';
import type { IdentityKeyConfig, KeyPurpose, SecurityLevel } from '../types.js';

const VALID_ID = '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA';
const ATTR_PAYLOAD = '"><img src=x onerror="window.__xss=1">';
const TEXT_PAYLOAD = '<img src=x onerror=window.__xss=1>';

function makeKey(id: number, purpose: KeyPurpose, securityLevel: SecurityLevel): IdentityKeyConfig {
  const { privateKey, publicKey } = generateKeyPair();
  return {
    id,
    name: `Key ${id}`,
    keyType: 'ECDSA_SECP256K1',
    purpose,
    securityLevel,
    privateKey,
    publicKey,
    privateKeyHex: bytesToHex(privateKey),
    privateKeyWif: privateKeyToWif(privateKey, TESTNET),
    publicKeyHex: bytesToHex(publicKey),
    dataBase64: '',
  };
}

/** A backup exactly as the app's own "Download Key Backup" writes it. */
function appBackup(): { json: unknown; keys: IdentityKeyConfig[] } {
  const keys = [
    makeKey(0, 'AUTHENTICATION', 'MASTER'),
    makeKey(1, 'AUTHENTICATION', 'CRITICAL'),
    makeKey(2, 'AUTHENTICATION', 'HIGH'),
    makeKey(3, 'TRANSFER', 'CRITICAL'),
  ];
  const state = { ...createInitialState('testnet'), identityId: VALID_ID, identityKeys: keys };
  return { json: JSON.parse(createKeyBackup(state)), keys };
}

describe('parseKeyBackup', () => {
  it('imports a backup produced by the app', () => {
    const { json, keys } = appBackup();
    expect(parseKeyBackup(json)).toEqual({
      identityId: VALID_ID,
      privateKeyWif: keys[2].privateKeyWif,
      purpose: 'AUTHENTICATION',
      securityLevel: 'HIGH',
    });
    expect(parseKeyBackup(json, 'TRANSFER')?.privateKeyWif).toBe(keys[3].privateKeyWif);
  });

  it('trims surrounding whitespace from the identity ID and WIF', () => {
    const { keys } = appBackup();
    const backup = {
      identityId: `  ${VALID_ID}\n`,
      identityKeys: [{ purpose: 'AUTHENTICATION', securityLevel: 'HIGH', privateKeyWif: ` ${keys[2].privateKeyWif} ` }],
    };
    expect(parseKeyBackup(backup)).toMatchObject({ identityId: VALID_ID, privateKeyWif: keys[2].privateKeyWif });
  });

  it.each([ATTR_PAYLOAD, TEXT_PAYLOAD, `${VALID_ID}"`, '1'.repeat(44)])(
    'rejects a backup with a malformed identity ID: %s',
    (identityId) => {
      const { json } = appBackup();
      expect(parseKeyBackup({ ...(json as object), identityId })).toBeNull();
    },
  );

  it('rejects a non-string identity ID', () => {
    const { json } = appBackup();
    expect(parseKeyBackup({ ...(json as object), identityId: { toString: () => VALID_ID } })).toBeNull();
    expect(parseKeyBackup({ ...(json as object), identityId: [VALID_ID] })).toBeNull();
  });

  it.each([ATTR_PAYLOAD, TEXT_PAYLOAD, 'cValidLooking"Wif', 42])(
    'rejects a backup whose only WIF is not a Base58 string: %s',
    (privateKeyWif) => {
      const backup = {
        identityId: VALID_ID,
        identityKeys: [{ purpose: 'AUTHENTICATION', securityLevel: 'HIGH', privateKeyWif }],
      };
      expect(parseKeyBackup(backup)).toBeNull();
    },
  );

  it('never selects a key whose WIF is not Base58', () => {
    const { json, keys } = appBackup();
    const backup = json as { identityKeys: Record<string, unknown>[] };
    backup.identityKeys.unshift({ purpose: 'AUTHENTICATION', securityLevel: 'HIGH', privateKeyWif: ATTR_PAYLOAD });
    expect(parseKeyBackup(backup)?.privateKeyWif).toBe(keys[2].privateKeyWif);
  });

  it('falls back to UNKNOWN for non-string purpose / security level', () => {
    const { keys } = appBackup();
    const backup = {
      identityId: VALID_ID,
      identityKeys: [{ purpose: { x: 1 }, securityLevel: 7, privateKeyWif: keys[0].privateKeyWif }],
    };
    expect(parseKeyBackup(backup)).toMatchObject({ purpose: 'UNKNOWN', securityLevel: 'UNKNOWN' });
  });
});

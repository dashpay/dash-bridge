import { describe, it, expect } from 'vitest';
import { checkLoginKey, describeLoginFetchError, signLogin, validateLoginWif, MASTER_KEY_REFUSED } from './login.js';
import { buildMessage } from '../embed/protocol.js';
import { buildLoginRedirectUrl, LOGIN_RESULT_FIELDS } from '../embed/login.js';
import { getPublicKey } from '../crypto/keys.js';
import { hash160 } from '../crypto/hash.js';
import { bytesToHex, hexToBytes } from '../utils/hex.js';
import { privateKeyToWif, wifToPrivateKey } from '../utils/wif.js';
import { MAINNET } from '../config.js';
import type { IdentityPublicKeyInfo } from '../types.js';
import {
  E2E_MOCK_IDENTITY_ID,
  E2E_MOCK_LOGIN_HASH160_WIF,
  E2E_MOCK_LOGIN_HIGH_WIF,
  E2E_MOCK_LOGIN_MASTER_WIF,
  E2E_MOCK_LOGIN_PUBLIC_KEYS,
  E2E_MOCK_LOGIN_TRANSFER_WIF,
} from '../e2e-mock-constants.js';

const KEYS: IdentityPublicKeyInfo[] = E2E_MOCK_LOGIN_PUBLIC_KEYS.map((k) => ({ ...k, data: hexToBytes(k.data), isDisabled: false }));

describe('mock login constants', () => {
  it('pair each WIF with its public key data', () => {
    const wifs = [E2E_MOCK_LOGIN_MASTER_WIF, E2E_MOCK_LOGIN_HIGH_WIF, E2E_MOCK_LOGIN_HASH160_WIF, E2E_MOCK_LOGIN_TRANSFER_WIF];
    wifs.forEach((wif, i) => {
      const publicKey = getPublicKey(wifToPrivateKey(wif).privateKey);
      const key = E2E_MOCK_LOGIN_PUBLIC_KEYS[i];
      expect(key.data).toBe(bytesToHex(key.type === 2 ? hash160(publicKey) : publicKey));
    });
  });
});

describe('checkLoginKey', () => {
  it('accepts HIGH and CRITICAL authentication keys, including HASH160 keys', () => {
    expect(checkLoginKey(E2E_MOCK_LOGIN_HIGH_WIF, KEYS, 'testnet')).toEqual({
      ok: true,
      key: { keyId: 1, securityLevel: 2, type: 0 },
    });
    expect(checkLoginKey(E2E_MOCK_LOGIN_HASH160_WIF, KEYS, 'testnet')).toEqual({
      ok: true,
      key: { keyId: 2, securityLevel: 1, type: 2 },
    });
  });

  it('refuses the MASTER key with a clear warning', () => {
    expect(checkLoginKey(E2E_MOCK_LOGIN_MASTER_WIF, KEYS, 'testnet')).toEqual({ ok: false, error: MASTER_KEY_REFUSED });
    expect(MASTER_KEY_REFUSED).toContain('never paste your MASTER key');
  });

  it('refuses other purposes, MEDIUM keys, disabled keys and foreign keys', () => {
    expect(checkLoginKey(E2E_MOCK_LOGIN_TRANSFER_WIF, KEYS, 'testnet')).toMatchObject({ ok: false, error: expect.stringContaining('TRANSFER purpose') });
    const medium = KEYS.map((k) => (k.id === 1 ? { ...k, securityLevel: 3 } : k));
    expect(checkLoginKey(E2E_MOCK_LOGIN_HIGH_WIF, medium, 'testnet')).toMatchObject({ ok: false, error: expect.stringContaining('MEDIUM') });
    const disabled = KEYS.map((k) => (k.id === 1 ? { ...k, isDisabled: true } : k));
    expect(checkLoginKey(E2E_MOCK_LOGIN_HIGH_WIF, disabled, 'testnet')).toMatchObject({ ok: false, error: expect.stringContaining('disabled') });
    expect(checkLoginKey(E2E_MOCK_LOGIN_HIGH_WIF, KEYS.filter((k) => k.id !== 1), 'testnet')).toMatchObject({
      ok: false,
      error: 'This key does not belong to this identity.',
    });
  });

  it('checks the WIF format and network', () => {
    const mainnetWif = privateKeyToWif(wifToPrivateKey(E2E_MOCK_LOGIN_HIGH_WIF).privateKey, MAINNET);
    expect(validateLoginWif(mainnetWif, 'testnet')).toBe('This private key is not for testnet.');
    expect(validateLoginWif(mainnetWif, 'mainnet')).toBeNull();
    expect(validateLoginWif('not-a-wif', 'testnet')).toContain('not a valid private key');
    expect(validateLoginWif('', 'testnet')).toContain('Enter the private key');
    expect(checkLoginKey(mainnetWif, KEYS, 'testnet')).toMatchObject({ ok: false, error: 'This private key is not for testnet.' });
  });
});

describe('describeLoginFetchError', () => {
  it('tells "not found" apart from network failures', () => {
    expect(describeLoginFetchError(new Error('Identity not found'), 'testnet')).toBe(
      'Identity not found on testnet. Check the identity ID and network.',
    );
    expect(describeLoginFetchError(new Error('Identity has no keys'), 'mainnet')).toContain('Identity not found on mainnet');
    expect(describeLoginFetchError(new Error('Failed to fetch'), 'testnet')).toContain('Could not reach Dash Platform');
  });
});

describe('signLogin', () => {
  it('never puts the WIF or private key in the result, the message or the redirect', async () => {
    const result = await signLogin({
      origin: 'https://app.example',
      identityId: E2E_MOCK_IDENTITY_ID,
      network: 'testnet',
      nonce: 'abcdefghijklmnop1234',
      keyId: 1,
      privateKeyWif: E2E_MOCK_LOGIN_HIGH_WIF,
      now: Date.UTC(2026, 9, 7, 12, 0, 0),
    });
    expect(Object.keys(result).sort()).toEqual([...LOGIN_RESULT_FIELDS].sort());
    const privateHex = bytesToHex(wifToPrivateKey(E2E_MOCK_LOGIN_HIGH_WIF).privateKey);
    const message = buildMessage('login', { request: 'login', requestId: 'r1' }, { ...result, privateKeyWif: E2E_MOCK_LOGIN_HIGH_WIF } as never);
    const redirect = buildLoginRedirectUrl('https://app.example/cb', { ...result, privateKeyWif: E2E_MOCK_LOGIN_HIGH_WIF } as never);
    const fragment = atob(new URL(redirect).hash.slice('#dash_login='.length).replace(/-/g, '+').replace(/_/g, '/'));
    for (const text of [JSON.stringify(result), JSON.stringify(message), redirect, fragment]) {
      expect(text).not.toContain(E2E_MOCK_LOGIN_HIGH_WIF);
      expect(text).not.toContain(privateHex);
      expect(text).not.toMatch(/privateKey|wif/i);
    }
  });
});

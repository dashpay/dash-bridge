import { describe, it, expect, beforeAll } from 'vitest';
import dashcore from '@dashevo/dashcore-lib';
import { verifyLogin, type VerifierPublicKey, type VerifyLoginOptions } from './verify.js';
import { signLogin } from '../platform/login.js';
import { dashMessageHash, recoverDashMessageSigner, signDashMessage } from '../crypto/message-signing.js';
import { buildLoginMessage, type LoginResult } from '../embed/login.js';
import { wifToPrivateKey } from '../utils/wif.js';
import { bytesToHex } from '../utils/hex.js';
import {
  E2E_MOCK_IDENTITY_ID,
  E2E_MOCK_LOGIN_HASH160_WIF,
  E2E_MOCK_LOGIN_HIGH_WIF,
  E2E_MOCK_LOGIN_MASTER_WIF,
  E2E_MOCK_LOGIN_PUBLIC_KEYS,
  E2E_MOCK_LOGIN_TRANSFER_WIF,
} from '../e2e-mock-constants.js';

const ORIGIN = 'https://app.example';
const NONCE = 'n0nce_for-unit-tests';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const KEYS: VerifierPublicKey[] = E2E_MOCK_LOGIN_PUBLIC_KEYS.map((k) => ({ ...k }));
const OPTIONS: VerifyLoginOptions = {
  expectedOrigin: ORIGIN,
  expectedNonce: NONCE,
  network: 'testnet',
  identityPublicKeys: KEYS,
  now: NOW + 30_000,
};

function sign(privateKeyWif: string, keyId: number, extra: { statement?: string; now?: number } = {}): Promise<LoginResult> {
  return signLogin({
    origin: ORIGIN,
    identityId: E2E_MOCK_IDENTITY_ID,
    network: 'testnet',
    nonce: NONCE,
    keyId,
    privateKeyWif,
    now: NOW,
    ...extra,
  });
}

let high: LoginResult;
beforeAll(async () => {
  high = await sign(E2E_MOCK_LOGIN_HIGH_WIF, 1, { statement: 'Welcome back' });
});

describe('verifyLogin', () => {
  it('accepts a login signed with a HIGH authentication key', () => {
    expect(verifyLogin(high, OPTIONS)).toEqual({ ok: true, identityId: E2E_MOCK_IDENTITY_ID, keyId: 1 });
    expect(verifyLogin(high, { ...OPTIONS, expectedStatement: 'Welcome back' }).ok).toBe(true);
  });

  it('accepts a CRITICAL ECDSA_HASH160 key', async () => {
    const result = await sign(E2E_MOCK_LOGIN_HASH160_WIF, 2);
    expect(verifyLogin(result, OPTIONS)).toEqual({ ok: true, identityId: E2E_MOCK_IDENTITY_ID, keyId: 2 });
  });

  it.each<[string, Partial<LoginResult>, string]>([
    ['identityId', { identityId: '4uvqP8FNZCyqYgPe3GUxP18RWdiLqxne1h4d4byFhdqK' }, 'message_mismatch'],
    ['keyId', { keyId: 2 }, 'message_mismatch'],
    ['issuedAt', { issuedAt: '2026-10-07T12:00:01Z' }, 'message_mismatch'],
    ['expiresAt', { expiresAt: '2026-10-07T12:09:59Z' }, 'message_mismatch'],
    ['message', { message: 'x' }, 'origin_mismatch'],
    ['nonce', { nonce: 'another-nonce-1234' }, 'nonce_mismatch'],
    ['network', { network: 'mainnet' }, 'network_mismatch'],
    ['signature', { signature: 'AAAA' }, 'invalid_signature'],
  ])('rejects a tampered %s', (_field, tamper, reason) => {
    expect(verifyLogin({ ...high, ...tamper }, OPTIONS)).toEqual({ ok: false, reason });
  });

  it('rejects a message edited consistently with its fields (signature no longer matches)', () => {
    const message = high.message.replace('Key ID: 1', 'Key ID: 2');
    expect(verifyLogin({ ...high, keyId: 2, message }, OPTIONS)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a login for another origin, nonce or network', () => {
    expect(verifyLogin(high, { ...OPTIONS, expectedOrigin: 'https://evil.example' })).toEqual({ ok: false, reason: 'origin_mismatch' });
    expect(verifyLogin(high, { ...OPTIONS, expectedNonce: 'another-nonce-1234' })).toEqual({ ok: false, reason: 'nonce_mismatch' });
    expect(verifyLogin(high, { ...OPTIONS, network: 'mainnet' })).toEqual({ ok: false, reason: 'network_mismatch' });
    expect(verifyLogin(high, { ...OPTIONS, expectedStatement: 'Other' })).toEqual({ ok: false, reason: 'statement_mismatch' });
  });

  it('enforces the validity window with 60s of clock skew', () => {
    expect(verifyLogin(high, { ...OPTIONS, now: NOW - 60_000 }).ok).toBe(true);
    expect(verifyLogin(high, { ...OPTIONS, now: NOW - 61_000 })).toEqual({ ok: false, reason: 'not_yet_valid' });
    expect(verifyLogin(high, { ...OPTIONS, now: NOW + 10 * 60_000 - 1 }).ok).toBe(true);
    expect(verifyLogin(high, { ...OPTIONS, now: NOW + 10 * 60_000 })).toEqual({ ok: false, reason: 'expired' });
    expect(verifyLogin(high, { ...OPTIONS, now: new Date(NOW + 60_000) }).ok).toBe(true);
  });

  it('rejects a validity window longer than 10 minutes, even if correctly signed', async () => {
    const fields = {
      origin: ORIGIN,
      identityId: E2E_MOCK_IDENTITY_ID,
      network: 'testnet',
      keyId: 1,
      nonce: NONCE,
      issuedAt: '2026-10-07T12:00:00Z',
      expiresAt: '2026-10-08T12:00:00Z',
    };
    const message = buildLoginMessage(fields);
    const signature = await signDashMessage(message, wifToPrivateKey(E2E_MOCK_LOGIN_HIGH_WIF).privateKey);
    const { origin: _origin, ...rest } = fields;
    expect(verifyLogin({ ...rest, message, signature }, OPTIONS)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a MASTER key', async () => {
    const result = await sign(E2E_MOCK_LOGIN_MASTER_WIF, 0);
    expect(verifyLogin(result, OPTIONS)).toEqual({ ok: false, reason: 'wrong_security_level' });
  });

  it('refuses a disabled key', () => {
    const keys = KEYS.map((k) => (k.id === 1 ? { ...k, disabledAt: 1_700_000_000_000 } : k));
    expect(verifyLogin(high, { ...OPTIONS, identityPublicKeys: keys })).toEqual({ ok: false, reason: 'key_disabled' });
    const flagged = KEYS.map((k) => (k.id === 1 ? { ...k, isDisabled: true } : k));
    expect(verifyLogin(high, { ...OPTIONS, identityPublicKeys: flagged })).toEqual({ ok: false, reason: 'key_disabled' });
  });

  it('refuses a contract-bound key', () => {
    const bounds = { contractId: '7'.repeat(44), type: 'singleContract' };
    for (const key of [
      { ...KEYS[1], contractBounds: bounds },
      // IdentityPublicKey getter shape
      { keyId: 1, keyType: 'ECDSA_SECP256K1', purpose: 'AUTHENTICATION', securityLevel: 'HIGH', data: KEYS[1].data, contractBounds: bounds },
    ]) {
      expect(verifyLogin(high, { ...OPTIONS, identityPublicKeys: [key] })).toEqual({ ok: false, reason: 'key_contract_bound' });
    }
    // toJSON() reports unbound keys as null.
    expect(verifyLogin(high, { ...OPTIONS, identityPublicKeys: [{ ...KEYS[1], contractBounds: null }] }).ok).toBe(true);
  });

  it('rejects a clock that is not a valid time instead of skipping the time checks', () => {
    expect(verifyLogin(high, { ...OPTIONS, now: Number.NaN })).toEqual({ ok: false, reason: 'invalid_options' });
    expect(verifyLogin(high, { ...OPTIONS, now: new Date('nope') })).toEqual({ ok: false, reason: 'invalid_options' });
    expect(verifyLogin(high, { ...OPTIONS, now: Infinity })).toEqual({ ok: false, reason: 'invalid_options' });
  });

  it('refuses a key with another purpose', async () => {
    const result = await sign(E2E_MOCK_LOGIN_TRANSFER_WIF, 3);
    expect(verifyLogin(result, OPTIONS)).toEqual({ ok: false, reason: 'wrong_key_purpose' });
  });

  it('refuses a MEDIUM key and unknown key types', () => {
    const medium = KEYS.map((k) => (k.id === 1 ? { ...k, securityLevel: 3 } : k));
    expect(verifyLogin(high, { ...OPTIONS, identityPublicKeys: medium })).toEqual({ ok: false, reason: 'wrong_security_level' });
    const bls = KEYS.map((k) => (k.id === 1 ? { ...k, type: 1 } : k));
    expect(verifyLogin(high, { ...OPTIONS, identityPublicKeys: bls })).toEqual({ ok: false, reason: 'unsupported_key_type' });
  });

  it('rejects a key ID that is not on the identity', () => {
    const keys = KEYS.filter((k) => k.id !== 1);
    expect(verifyLogin(high, { ...OPTIONS, identityPublicKeys: keys })).toEqual({ ok: false, reason: 'key_not_found' });
  });

  it('rejects a signature made by another key of the identity (wrong key ID)', async () => {
    // Signed by the HASH160 key's private key, but claims key #1.
    const result = await sign(E2E_MOCK_LOGIN_HASH160_WIF, 1);
    expect(verifyLogin(result, OPTIONS)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects malformed input', () => {
    expect(verifyLogin(null, OPTIONS)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyLogin({ ...high, issuedAt: 'yesterday' }, OPTIONS)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyLogin({ ...high, keyId: '1' }, OPTIONS)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts the key shapes evo-sdk returns', () => {
    const hex = KEYS[1].data as string;
    const bytes = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
    const shapes: VerifierPublicKey[] = [
      // identity.toJSON().publicKeys: base64 data
      { id: 1, type: 0, purpose: 0, securityLevel: 2, data: btoa(String.fromCharCode(...bytes)) },
      // IdentityPublicKey#toJSON(): number[] data
      { id: 1, type: 0, purpose: 0, securityLevel: 2, data: Array.from(bytes) },
      // IdentityPublicKey getters: string enums, hex data, disabledAt undefined
      { keyId: 1, keyType: 'ECDSA_SECP256K1', purpose: 'AUTHENTICATION', securityLevel: 'HIGH', data: hex, disabledAt: undefined },
      // toObject(): Uint8Array data
      { id: 1, type: 0, purpose: 0, securityLevel: 2, data: bytes, disabledAt: null },
    ];
    for (const key of shapes) {
      expect(verifyLogin(high, { ...OPTIONS, identityPublicKeys: [key] })).toMatchObject({ ok: true });
    }
    const disabled = { keyId: 1, keyType: 'ECDSA_SECP256K1', purpose: 'AUTHENTICATION', securityLevel: 'HIGH', data: hex, disabledAt: 5n };
    expect(verifyLogin(high, { ...OPTIONS, identityPublicKeys: [disabled] })).toEqual({ ok: false, reason: 'key_disabled' });
  });

  it('accepts real evo-sdk IdentityPublicKey objects and identity.toJSON() keys', async () => {
    const sdk = await import('@dashevo/evo-sdk');
    await (sdk as unknown as { ensureInitialized: () => Promise<unknown> }).ensureInitialized();
    const toBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
    const keys = [
      new sdk.IdentityPublicKey({ keyId: 1, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_secp256k1', data: toBytes(KEYS[1].data as string) }),
      new sdk.IdentityPublicKey({ keyId: 2, purpose: 'authentication', securityLevel: 'critical', keyType: 'ecdsa_hash160', data: toBytes(KEYS[2].data as string) }),
    ];
    const identity = new sdk.Identity(new Uint8Array(32).fill(7));
    for (const key of keys) identity.addPublicKey(key);
    const jsonKeys = identity.toJSON().publicKeys;
    const hash160Login = await sign(E2E_MOCK_LOGIN_HASH160_WIF, 2);

    for (const identityPublicKeys of [keys, jsonKeys, keys.map((k) => k.toJSON()), keys.map((k) => k.toObject())]) {
      expect(verifyLogin(high, { ...OPTIONS, identityPublicKeys: identityPublicKeys as VerifierPublicKey[] }).ok).toBe(true);
      expect(verifyLogin(hash160Login, { ...OPTIONS, identityPublicKeys: identityPublicKeys as VerifierPublicKey[] }).ok).toBe(true);
    }
  });
});

describe('Dash signed messages', () => {
  const privateKey = wifToPrivateKey(E2E_MOCK_LOGIN_HIGH_WIF).privateKey;
  const { Message, PrivateKey } = dashcore as unknown as {
    Message: new (text: string) => { sign(key: unknown): string; verify(address: unknown, sig: string): boolean; magicHash(): Uint8Array };
    PrivateKey: { fromWIF(wif: string): { toAddress(): unknown } };
  };

  it('hashes like dashcore-lib, including non-ASCII and long messages', () => {
    for (const text of ['hello', 'Grüße 🚀', 'x'.repeat(300), high.message]) {
      expect(bytesToHex(dashMessageHash(text))).toBe(bytesToHex(new Message(text).magicHash()));
    }
  });

  it('produces signatures dashcore-lib verifies, and verifies dashcore-lib signatures', async () => {
    const address = PrivateKey.fromWIF(E2E_MOCK_LOGIN_HIGH_WIF).toAddress();
    for (const text of [high.message, 'Grüße 🚀', 'x'.repeat(300)]) {
      const ours = await signDashMessage(text, privateKey);
      expect(new Message(text).verify(address, ours)).toBe(true);
      const theirs = new Message(text).sign(PrivateKey.fromWIF(E2E_MOCK_LOGIN_HIGH_WIF));
      expect(bytesToHex(recoverDashMessageSigner(text, theirs)!)).toBe(E2E_MOCK_LOGIN_PUBLIC_KEYS[1].data);
    }
  });

  it('is deterministic (RFC 6979) and matches a golden signature', async () => {
    const signature = await signDashMessage('Sign in with Dash', privateKey);
    expect(await signDashMessage('Sign in with Dash', privateKey)).toBe(signature);
    expect(atob(signature).length).toBe(65);
    expect([31, 32, 33, 34]).toContain(atob(signature).charCodeAt(0));
    expect(signature).toBe(GOLDEN_SIGNATURE);
    expect(new Message('Sign in with Dash').verify(PrivateKey.fromWIF(E2E_MOCK_LOGIN_HIGH_WIF).toAddress(), GOLDEN_SIGNATURE)).toBe(true);
  });

  it('rejects uncompressed-key headers and garbage', () => {
    const sig = Uint8Array.from(atob(high.signature), (c) => c.charCodeAt(0));
    sig[0] -= 4; // 27-30: uncompressed key
    expect(recoverDashMessageSigner(high.message, btoa(String.fromCharCode(...sig)))).toBeNull();
    expect(recoverDashMessageSigner(high.message, 'not base64!')).toBeNull();
    expect(recoverDashMessageSigner(high.message, btoa('short'))).toBeNull();
  });
});

/** dashcore-lib verifies it too (see the next assertion in that test). */
const GOLDEN_SIGNATURE = 'H9rOGm8fmErYTJNaImot3YSPZBCBy5sAcV0Xc/2v3yWeMazB+rvUoxo3h5GzJL9IJAypDFwGpwkj4QOmACMbyG0=';

import { describe, it, expect } from 'vitest';
import {
  buildMessage,
  parseBridgeMessage,
  parseEmbedParams,
  parseRequestOrigin,
  sanitizeAppName,
  isValidRequestId,
  MESSAGE_TYPES,
  type MessagePayloads,
  type MessageType,
} from './protocol.js';

const ENVELOPE_KEYS = ['source', 'version', 'type', 'request', 'requestId'];
const CTX = { request: 'create-identity', requestId: 'req_1' };

/** Secrets that must never appear in a message, even if passed by mistake. */
const SECRETS = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  privateKeyWif: 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy',
  assetLockKeyPair: { privateKey: new Uint8Array(32) },
  keyBackup: '{"mnemonic":"..."}',
  identityKeys: [{ privateKeyWif: 'x' }],
};

const SAMPLE_PAYLOADS: { [T in MessageType]: MessagePayloads[T] } = {
  ready: {},
  progress: { step: 'awaiting_deposit' },
  'identity-created': { identityId: '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA', network: 'testnet' },
  login: {
    identityId: '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA',
    keyId: 1,
    network: 'testnet',
    message: 'app.example wants you to sign in with your Dash Platform identity: ...',
    signature: 'H'.repeat(88),
    nonce: 'n'.repeat(32),
    issuedAt: '2026-10-07T12:00:00Z',
    expiresAt: '2026-10-07T12:10:00Z',
  },
  error: { code: 'ERR-1005', message: 'InstantSend lock failed', fatal: false },
  cancelled: {},
  close: {},
};

const WHITELIST: Record<MessageType, string[]> = {
  ready: [],
  progress: ['step'],
  'identity-created': ['identityId', 'network'],
  login: ['identityId', 'keyId', 'network', 'message', 'signature', 'nonce', 'issuedAt', 'expiresAt'],
  error: ['code', 'message', 'fatal'],
  cancelled: [],
  close: [],
};

describe('buildMessage', () => {
  it.each(MESSAGE_TYPES)('emits only the envelope and whitelisted fields for %s', (type) => {
    const payload = { ...SAMPLE_PAYLOADS[type], ...SECRETS } as never;
    const msg = buildMessage(type, CTX, payload);

    expect(Object.keys(msg).sort()).toEqual([...ENVELOPE_KEYS, ...WHITELIST[type]].sort());
    expect(msg).toMatchObject({ source: 'dash-bridge', version: 1, type, request: 'create-identity', requestId: 'req_1' });
    const serialized = JSON.stringify(msg);
    expect(serialized).not.toContain('abandon');
    expect(serialized).not.toContain(SECRETS.privateKeyWif);
    expect(serialized).not.toMatch(/mnemonic|privateKey|keyBackup|identityKeys/);
  });

  it('omits requestId when the app did not send one', () => {
    const msg = buildMessage('ready', { request: 'create-identity' }, {});
    expect('requestId' in msg).toBe(false);
  });

  it('round-trips through the SDK parser', () => {
    for (const type of MESSAGE_TYPES) {
      const msg = buildMessage(type, CTX, SAMPLE_PAYLOADS[type] as never);
      expect(parseBridgeMessage(msg, { request: 'create-identity', requestId: 'req_1' })).toEqual(msg);
    }
  });
});

describe('parseBridgeMessage', () => {
  const expected = { request: 'create-identity' as const, requestId: 'req_1' };
  const valid = () => buildMessage('identity-created', CTX, SAMPLE_PAYLOADS['identity-created']);

  it('rejects messages that are not from the bridge protocol', () => {
    expect(parseBridgeMessage(null, expected)).toBeNull();
    expect(parseBridgeMessage('identity-created', expected)).toBeNull();
    expect(parseBridgeMessage({ ...valid(), source: 'other' }, expected)).toBeNull();
    expect(parseBridgeMessage({ ...valid(), version: 2 }, expected)).toBeNull();
    expect(parseBridgeMessage({ ...valid(), type: 'unknown' }, expected)).toBeNull();
  });

  it('rejects messages for another request', () => {
    expect(parseBridgeMessage({ ...valid(), requestId: 'other' }, expected)).toBeNull();
    expect(parseBridgeMessage({ ...valid(), requestId: undefined }, expected)).toBeNull();
    expect(parseBridgeMessage({ ...valid(), request: 'login' }, expected)).toBeNull();
  });

  it('rejects malformed payloads', () => {
    expect(parseBridgeMessage({ ...valid(), identityId: 42 }, expected)).toBeNull();
    expect(parseBridgeMessage({ ...buildMessage('progress', CTX, { step: 'complete' }), step: 'secret' }, expected)).toBeNull();
    expect(parseBridgeMessage({ ...buildMessage('error', CTX, SAMPLE_PAYLOADS.error), fatal: 'no' }, expected)).toBeNull();
  });
});

describe('parseRequestOrigin', () => {
  it.each([
    'https://app.example',
    'https://app.example:8443',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://[::1]:8080',
  ])('accepts %s', (origin) => {
    expect(parseRequestOrigin(origin)).toBe(origin);
  });

  it.each([
    null,
    '',
    '*',
    'null',
    'http://app.example',
    'https://app.example/',
    'https://app.example/path',
    'https://app.example?x=1',
    'https://user@app.example',
    'HTTPS://APP.EXAMPLE',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'ftp://app.example',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
  ])('rejects %s', (origin) => {
    expect(parseRequestOrigin(origin)).toBeNull();
  });
});

describe('sanitizeAppName / isValidRequestId', () => {
  it('strips bidi overrides and other format characters', () => {
    expect(sanitizeAppName('My\u202eppa\u202c App\u200b')).toBe('Myppa App');
    expect(sanitizeAppName('\u2066x\u2069')).toBe('x');
  });

  it('caps by code points without splitting surrogate pairs', () => {
    const name = sanitizeAppName('a'.repeat(63) + '\u{1F600}\u{1F600}');
    expect(name).toBe('a'.repeat(63) + '\u{1F600}');
  });

  it('trims, strips control characters and caps the app name', () => {
    expect(sanitizeAppName('  My\u0000 App\n ')).toBe('My App');
    expect(sanitizeAppName('x'.repeat(100))).toHaveLength(64);
    expect(sanitizeAppName('   ')).toBeUndefined();
    expect(sanitizeAppName(null)).toBeUndefined();
    expect(sanitizeAppName('Dash Wallet (https://dashpay.org)')).toBeUndefined();
  });

  it('validates request IDs', () => {
    expect(isValidRequestId('abc_DEF-123')).toBe(true);
    expect(isValidRequestId('a'.repeat(64))).toBe(true);
    expect(isValidRequestId('a'.repeat(65))).toBe(false);
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId('a b')).toBe(false);
    expect(isValidRequestId('<x>')).toBe(false);
  });
});

describe('parseEmbedParams', () => {
  it('returns none without embed', () => {
    expect(parseEmbedParams('?network=mainnet')).toEqual({ status: 'none' });
  });

  it('parses a full popup request', () => {
    expect(
      parseEmbedParams('?embed=popup&origin=https://app.example&app=My%20App&network=mainnet&requestId=r1'),
    ).toEqual({
      status: 'ok',
      params: {
        kind: 'popup',
        origin: 'https://app.example',
        appName: 'My App',
        request: 'create-identity',
        network: 'mainnet',
        requestId: 'r1',
      },
    });
  });

  it('defaults to create-identity on testnet', () => {
    const result = parseEmbedParams('?embed=iframe&origin=http://localhost:3000');
    expect(result).toMatchObject({ status: 'ok', params: { request: 'create-identity', network: 'testnet' } });
  });

  it.each([
    ['?embed=window&origin=https://app.example', 'Unknown embed mode'],
    ['?embed=popup', 'valid origin'],
    ['?embed=popup&origin=http://app.example', 'valid origin'],
    ['?embed=popup&origin=https://app.example&requestId=bad%20id', 'request ID'],
    ['?embed=popup&origin=https://app.example&request=%3Cx%3E', 'request type'],
  ])('rejects %s', (query, reason) => {
    const result = parseEmbedParams(query);
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toContain(reason);
  });

  it('flags unsupported requests and networks so the app can be told', () => {
    expect(parseEmbedParams('?embed=popup&origin=https://app.example&request=sign-tx&requestId=r')).toMatchObject({
      status: 'unsupported',
      code: 'unsupported_request',
      params: { request: 'sign-tx', requestId: 'r', origin: 'https://app.example' },
    });
    expect(parseEmbedParams('?embed=popup&origin=https://app.example&network=devnet')).toMatchObject({
      status: 'unsupported',
      code: 'unsupported_network',
    });
  });
});

describe('parseEmbedParams: login', () => {
  const NONCE = 'abcdefghijklmnop1234';
  const base = `?origin=https://app.example&request=login&nonce=${NONCE}`;

  it('parses a popup login with a sanitized statement', () => {
    expect(parseEmbedParams(`${base}&embed=popup&network=mainnet&statement=${encodeURIComponent('Hi\nthere‮')}`)).toEqual({
      status: 'ok',
      params: {
        kind: 'popup',
        origin: 'https://app.example',
        request: 'login',
        network: 'mainnet',
        appName: undefined,
        requestId: undefined,
        login: { nonce: NONCE, statement: 'Hi there', returnUrl: undefined },
      },
    });
  });

  it('parses a redirect login with a return URL on the declared origin', () => {
    const returnUrl = 'https://app.example/auth/callback';
    const result = parseEmbedParams(`${base}&embed=redirect&returnUrl=${encodeURIComponent(returnUrl)}`);
    expect(result).toMatchObject({ status: 'ok', params: { kind: 'redirect', login: { nonce: NONCE, returnUrl } } });
  });

  it.each([
    [`${base}&embed=redirect&returnUrl=${encodeURIComponent('https://evil.example/cb')}`, 'return URL'],
    [`${base}&embed=redirect&returnUrl=${encodeURIComponent('https://app.example.evil.example/cb')}`, 'return URL'],
    [`${base}&embed=redirect&returnUrl=${encodeURIComponent('http://app.example/cb')}`, 'return URL'],
    [`${base}&embed=redirect`, 'return URL'],
    [`${base}&embed=redirect&returnUrl=${encodeURIComponent('https://app.example/out?to=https://evil.example')}`, 'query string'],
    [`${base}&embed=redirect&returnUrl=${encodeURIComponent('https://app.example/cb?')}`, 'query string'],
    [`${base}&embed=redirect&returnUrl=${encodeURIComponent('blob:https://app.example/1234')}`, 'return URL'],
    [`?origin=https://app.example&embed=redirect&returnUrl=${encodeURIComponent('https://app.example/cb')}`, 'only available for sign-in'],
    ['?origin=https://app.example&request=login&embed=popup', 'nonce'],
    ['?origin=https://app.example&request=login&embed=popup&nonce=short', 'nonce'],
    [`?origin=https://app.example&request=login&embed=popup&nonce=${'a'.repeat(16)}%20x`, 'nonce'],
  ])('rejects %s', (query, reason) => {
    const result = parseEmbedParams(query);
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toContain(reason);
  });
});

describe('parseEmbedParams: login modes and networks', () => {
  const base = '?origin=https://app.example&request=login&nonce=abcdefghijklmnop1234';

  it('refuses iframe logins as unsupported, so the framing app is told', () => {
    expect(parseEmbedParams(`${base}&embed=iframe`)).toMatchObject({
      status: 'unsupported',
      code: 'unsupported_mode',
      params: { kind: 'iframe', request: 'login' },
    });
  });

  it('keeps the redirect target for an unsupported network', () => {
    const returnUrl = 'https://app.example/cb';
    expect(parseEmbedParams(`${base}&embed=redirect&network=devnet&returnUrl=${encodeURIComponent(returnUrl)}`)).toMatchObject({
      status: 'unsupported',
      code: 'unsupported_network',
      params: { kind: 'redirect', login: { returnUrl } },
    });
  });
});

describe('parseBridgeMessage: login', () => {
  const ctx = { request: 'login' as const, requestId: 'req_1' };
  const valid = () => buildMessage('login', ctx, SAMPLE_PAYLOADS.login);

  it('accepts a well-formed login result for the login request only', () => {
    expect(parseBridgeMessage(valid(), ctx)).toEqual(valid());
    expect(parseBridgeMessage(valid(), { request: 'create-identity', requestId: 'req_1' })).toBeNull();
  });

  it('rejects malformed login payloads', () => {
    expect(parseBridgeMessage({ ...valid(), keyId: '1' }, ctx)).toBeNull();
    expect(parseBridgeMessage({ ...valid(), signature: 5 }, ctx)).toBeNull();
  });
});

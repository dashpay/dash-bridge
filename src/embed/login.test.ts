import { describe, it, expect } from 'vitest';
import {
  buildLoginMessage,
  buildLoginRedirectUrl,
  formatLoginTime,
  isLoginTime,
  isValidNonce,
  loginValidity,
  parseLoginFragment,
  parseLoginMessage,
  parseReturnUrl,
  pickLoginResult,
  sanitizeStatement,
  LOGIN_RESULT_FIELDS,
  type LoginMessageFields,
  type LoginResult,
} from './login.js';

const IDENTITY_ID = '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA';
const FIELDS: LoginMessageFields = {
  origin: 'https://app.example',
  identityId: IDENTITY_ID,
  network: 'testnet',
  keyId: 1,
  nonce: 'abcdefghijklmnop1234',
  issuedAt: '2026-10-07T12:00:00Z',
  expiresAt: '2026-10-07T12:10:00Z',
};

const RESULT: LoginResult = {
  identityId: IDENTITY_ID,
  keyId: 1,
  network: 'testnet',
  message: buildLoginMessage(FIELDS),
  signature: 'H'.repeat(88),
  nonce: FIELDS.nonce,
  issuedAt: FIELDS.issuedAt,
  expiresAt: FIELDS.expiresAt,
};

describe('buildLoginMessage', () => {
  it('matches the golden message without a statement', () => {
    expect(buildLoginMessage(FIELDS)).toBe(
      'app.example wants you to sign in with your Dash Platform identity:\n' +
        '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA\n' +
        '\n' +
        'URI: https://app.example\n' +
        'Network: testnet\n' +
        'Key ID: 1\n' +
        'Nonce: abcdefghijklmnop1234\n' +
        'Issued At: 2026-10-07T12:00:00Z\n' +
        'Expiration Time: 2026-10-07T12:10:00Z',
    );
  });

  it('matches the golden message with a statement and a port', () => {
    expect(
      buildLoginMessage({ ...FIELDS, origin: 'http://localhost:5173', statement: 'Sign in to Example', network: 'mainnet', keyId: 12 }),
    ).toBe(
      'localhost:5173 wants you to sign in with your Dash Platform identity:\n' +
        '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA\n' +
        '\n' +
        'Sign in to Example\n' +
        '\n' +
        'URI: http://localhost:5173\n' +
        'Network: mainnet\n' +
        'Key ID: 12\n' +
        'Nonce: abcdefghijklmnop1234\n' +
        'Issued At: 2026-10-07T12:00:00Z\n' +
        'Expiration Time: 2026-10-07T12:10:00Z',
    );
  });

  it('matches the golden redirect-mode message, with the Redirect URI after URI', () => {
    expect(buildLoginMessage({ ...FIELDS, statement: 'Hi', returnUrl: 'https://app.example/auth/callback' })).toBe(
      'app.example wants you to sign in with your Dash Platform identity:\n' +
        '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA\n' +
        '\n' +
        'Hi\n' +
        '\n' +
        'URI: https://app.example\n' +
        'Redirect URI: https://app.example/auth/callback\n' +
        'Network: testnet\n' +
        'Key ID: 1\n' +
        'Nonce: abcdefghijklmnop1234\n' +
        'Issued At: 2026-10-07T12:00:00Z\n' +
        'Expiration Time: 2026-10-07T12:10:00Z',
    );
  });

  it.each([
    'https://evil.example/cb',
    'https://app.example/cb?x=1',
    'https://app.example/cb#frag',
    'https://app.example/cb\nNetwork: mainnet',
  ])('refuses the Redirect URI %j', (returnUrl) => {
    expect(() => buildLoginMessage({ ...FIELDS, returnUrl })).toThrow('invalid return URL');
  });

  it('treats an empty statement like no statement', () => {
    expect(buildLoginMessage({ ...FIELDS, statement: '' })).toBe(buildLoginMessage(FIELDS));
  });

  it.each([
    ['an origin with a path', { origin: 'https://app.example/login' }],
    ['a bad identity ID', { identityId: 'not an id' }],
    ['a bad network', { network: 'Main Net' }],
    ['a negative key ID', { keyId: -1 }],
    ['a fractional key ID', { keyId: 1.5 }],
    ['a short nonce', { nonce: 'short' }],
    ['a nonce with spaces', { nonce: 'abcdefgh ijklmnop' }],
    ['milliseconds in a time', { issuedAt: '2026-10-07T12:00:00.000Z' }],
    ['a non-UTC time', { expiresAt: '2026-10-07T12:10:00+01:00' }],
    ['an impossible date', { issuedAt: '2026-02-30T12:00:00Z' }],
    ['a statement with a newline', { statement: 'line one\nURI: https://evil.example' }],
    ['an unsanitized statement', { statement: '  padded  ' }],
  ])('refuses %s', (_label, override) => {
    expect(() => buildLoginMessage({ ...FIELDS, ...override } as LoginMessageFields)).toThrow();
  });

  it('parses origin, statement and Redirect URI back by line prefix', () => {
    const returnUrl = 'https://app.example/cb';
    expect(parseLoginMessage(buildLoginMessage(FIELDS))).toEqual({ origin: 'https://app.example' });
    expect(parseLoginMessage(buildLoginMessage({ ...FIELDS, statement: 'Hello' }))).toEqual({
      origin: 'https://app.example',
      statement: 'Hello',
    });
    expect(parseLoginMessage(buildLoginMessage({ ...FIELDS, returnUrl }))).toEqual({ origin: 'https://app.example', returnUrl });
    expect(parseLoginMessage(buildLoginMessage({ ...FIELDS, statement: 'Hello', returnUrl }))).toEqual({
      origin: 'https://app.example',
      statement: 'Hello',
      returnUrl,
    });
    expect(parseLoginMessage('no uri line here')).toBeNull();
  });

  it('is not fooled by a statement that looks like a URI or Redirect URI line', () => {
    for (const statement of ['URI: https://evil.example', 'Redirect URI: https://evil.example/x']) {
      expect(parseLoginMessage(buildLoginMessage({ ...FIELDS, statement }))).toEqual({
        origin: 'https://app.example',
        statement,
      });
    }
  });
});

describe('times', () => {
  it('formats UTC with whole seconds', () => {
    expect(formatLoginTime(Date.UTC(2026, 9, 7, 12, 0, 0, 999))).toBe('2026-10-07T12:00:00Z');
    expect(isLoginTime('2026-10-07T12:00:00Z')).toBe(true);
    expect(isLoginTime('2026-10-07T12:00:00.000Z')).toBe(false);
  });

  it('expires 10 minutes after issue', () => {
    expect(loginValidity(Date.UTC(2026, 9, 7, 23, 55, 30, 500))).toEqual({
      issuedAt: '2026-10-07T23:55:30Z',
      expiresAt: '2026-10-08T00:05:30Z',
    });
  });
});

describe('sanitizeStatement', () => {
  it('flattens control characters and whitespace, strips bidi overrides', () => {
    expect(sanitizeStatement('  Hello\n\tworld‮!  ')).toBe('Hello world !');
    expect(sanitizeStatement('a b')).toBe('a b');
    expect(sanitizeStatement('\n​ ')).toBeUndefined();
    expect(sanitizeStatement(null)).toBeUndefined();
  });

  it('caps the length at 140 code points without splitting surrogate pairs', () => {
    expect(Array.from(sanitizeStatement('😀'.repeat(200))!)).toHaveLength(140);
  });

  it('is idempotent, so sanitized statements always build', () => {
    const once = sanitizeStatement(' x \u0000 y '.repeat(30))!;
    expect(sanitizeStatement(once)).toBe(once);
    expect(() => buildLoginMessage({ ...FIELDS, statement: once })).not.toThrow();
  });
});

describe('isValidNonce', () => {
  it('accepts 16-128 characters of [A-Za-z0-9_-]', () => {
    expect(isValidNonce('a'.repeat(16))).toBe(true);
    expect(isValidNonce('A-z_0'.repeat(25) + 'abc')).toBe(true);
    expect(isValidNonce('a'.repeat(15))).toBe(false);
    expect(isValidNonce('a'.repeat(129))).toBe(false);
    expect(isValidNonce('a'.repeat(16) + '=')).toBe(false);
    expect(isValidNonce(undefined)).toBe(false);
  });
});

describe('parseReturnUrl', () => {
  it('accepts URLs on exactly the declared origin', () => {
    expect(parseReturnUrl('https://app.example/cb', 'https://app.example')).toBe('https://app.example/cb');
    // The fragment is dropped: the bridge replaces it on delivery.
    expect(parseReturnUrl('https://app.example/cb#x', 'https://app.example')).toBe('https://app.example/cb');
    expect(parseReturnUrl('https://app.example', 'https://app.example')).toBe('https://app.example/');
    expect(parseReturnUrl('http://localhost:3000/cb', 'http://localhost:3000')).toBe('http://localhost:3000/cb');
  });

  it.each([
    'https://app.example/cb?x=1',
    'https://app.example/out?to=https://evil.example',
    'https://app.example/cb?',
    'https://app.example/cb?#frag',
    'blob:https://app.example/0b3f6f1e-1111-2222-3333-444455556666',
    'https://app.example.evil.example/cb',
    'https://evil.example/cb',
    'http://app.example/cb',
    'https://app.example:8443/cb',
    'https://user:pw@app.example/cb',
    '/cb',
    'javascript:alert(1)',
    '',
  ])('refuses %s', (url) => {
    expect(parseReturnUrl(url, 'https://app.example')).toBeNull();
  });
});

describe('redirect fragments', () => {
  it('round-trips a result through the fragment, replacing any existing fragment', () => {
    const url = new URL(buildLoginRedirectUrl('https://app.example/cb?x=1#old', RESULT));
    expect(url.origin + url.pathname + url.search).toBe('https://app.example/cb?x=1');
    expect(url.hash.startsWith('#dash_login=')).toBe(true);
    expect(parseLoginFragment(url.hash)).toEqual(RESULT);
  });

  it('keeps only whitelisted fields in the fragment', () => {
    const leaky = { ...RESULT, privateKeyWif: 'cSecret', mnemonic: 'abandon abandon' };
    const url = buildLoginRedirectUrl('https://app.example/cb', leaky);
    const decoded = parseLoginFragment(new URL(url).hash) as LoginResult;
    expect(Object.keys(decoded).sort()).toEqual([...LOGIN_RESULT_FIELDS].sort());
    expect(url).not.toContain('cSecret');
    expect(atob(new URL(url).hash.slice('#dash_login='.length).replace(/-/g, '+').replace(/_/g, '/'))).not.toContain('cSecret');
  });

  it('encodes errors', () => {
    const url = buildLoginRedirectUrl('https://app.example/cb', { error: 'cancelled' });
    expect(new URL(url).hash).toBe('#dash_login_error=cancelled');
    expect(parseLoginFragment(new URL(url).hash)).toEqual({ error: 'cancelled' });
  });

  it('ignores fragments without a login outcome and flags garbage', () => {
    expect(parseLoginFragment('')).toBeNull();
    expect(parseLoginFragment('#section-2')).toBeNull();
    expect(parseLoginFragment('#dash_login=!!!')).toEqual({ error: 'invalid_response' });
    expect(parseLoginFragment('#dash_login=' + btoa('{"identityId":1}'))).toEqual({ error: 'invalid_response' });
    expect(parseLoginFragment('#dash_login_error=<script>')).toEqual({ error: 'invalid_response' });
  });
});

describe('pickLoginResult', () => {
  it('rejects wrong types', () => {
    expect(pickLoginResult({ ...RESULT, keyId: '1' })).toBeNull();
    expect(pickLoginResult({ ...RESULT, keyId: -1 })).toBeNull();
    expect(pickLoginResult({ ...RESULT, signature: undefined })).toBeNull();
    expect(pickLoginResult(null)).toBeNull();
  });
});

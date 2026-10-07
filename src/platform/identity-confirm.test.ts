import { describe, it, expect } from 'vitest';
import {
  IdentityRegistrationUnconfirmedError,
  allowUnverifiedDevnetFallback,
  findMissingIdentityKeys,
  isAlreadyExistsError,
  isIdentityRegistrationUnconfirmedError,
  isTransportUnavailableError,
  pollForIdentity,
  publicKeyDataMatches,
} from './identity-confirm.js';

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe('isAlreadyExistsError', () => {
  it('matches the already-submitted family, including non-Error objects', () => {
    expect(isAlreadyExistsError(new Error('Object already exists: tx already exists in cache'))).toBe(true);
    expect(isAlreadyExistsError({ message: 'AlreadyExists' })).toBe(true);
    expect(isAlreadyExistsError(new Error('Asset lock transaction abcd output 0 already completely used'))).toBe(true);
    expect(isAlreadyExistsError(new Error('Identity 4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA already exists'))).toBe(true);
    expect(isAlreadyExistsError(new Error('identity key already exists for user'))).toBe(false);
    expect(isAlreadyExistsError(new Error('Instant lock proof signature is invalid'))).toBe(false);
  });
});

describe('pollForIdentity', () => {
  it('returns as soon as the identity is found', async () => {
    const results = [undefined, undefined, { id: 'x' }];
    const summary = await pollForIdentity(async () => results.shift(), {
      timeoutMs: 45_000,
      intervalMs: 5_000,
      ...fakeClock(),
    });
    expect(summary.identity).toEqual({ id: 'x' });
    expect(summary.attempts).toBe(3);
    expect(summary.notFound).toBe(2);
  });

  it('gives up after the window, counting misses and errors separately', async () => {
    let call = 0;
    const summary = await pollForIdentity(
      async () => {
        call++;
        if (call % 2 === 0) throw new Error('Transport error: unavailable');
        if (call === 3) throw new Error('Identity not found');
        return undefined;
      },
      { timeoutMs: 20_000, intervalMs: 5_000, ...fakeClock() }
    );
    expect(summary.identity).toBeUndefined();
    expect(summary.attempts).toBe(5); // t=0,5,10,15,20
    expect(summary.notFound).toBe(3); // calls 1, 3 (not-found error), 5
    expect(summary.errors).toHaveLength(2);
  });
});

describe('allowUnverifiedDevnetFallback', () => {
  const transportOnly = {
    attempts: 3,
    notFound: 0,
    errors: [new Error('TransportNoAvailableAddresses'), new Error('no available addresses')],
  };

  it('allows the legacy success only on devnet when Platform was never reachable', () => {
    expect(allowUnverifiedDevnetFallback('devnet', transportOnly)).toBe(true);
  });

  it('never allows it on mainnet or testnet', () => {
    expect(allowUnverifiedDevnetFallback('mainnet', transportOnly)).toBe(false);
    expect(allowUnverifiedDevnetFallback('testnet', transportOnly)).toBe(false);
  });

  it('refuses when any lookup got a definitive "not found"', () => {
    expect(allowUnverifiedDevnetFallback('devnet', { ...transportOnly, notFound: 1 })).toBe(false);
  });

  it('refuses when any failure was not a transport/unavailability error', () => {
    expect(
      allowUnverifiedDevnetFallback('devnet', {
        ...transportOnly,
        errors: [...transportOnly.errors, new Error('Timed out while confirming identity registration')],
      })
    ).toBe(false);
  });

  it('refuses when no lookup ran', () => {
    expect(allowUnverifiedDevnetFallback('devnet', { attempts: 0, notFound: 0, errors: [] })).toBe(false);
  });
});

describe('isTransportUnavailableError', () => {
  it('distinguishes transport failures from other errors', () => {
    expect(isTransportUnavailableError({ message: 'TransportNoAvailableAddresses' })).toBe(true);
    expect(isTransportUnavailableError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransportUnavailableError(new Error('invalid proof'))).toBe(false);
  });
});

describe('identity key matching', () => {
  const pub = new Uint8Array(33).map((_, i) => i + 1);
  const hash = new Uint8Array(20).fill(7);

  it('accepts hex, base64 and raw byte encodings', () => {
    expect(publicKeyDataMatches(toHex(pub), pub)).toBe(true);
    expect(publicKeyDataMatches(toB64(pub), pub)).toBe(true);
    expect(publicKeyDataMatches(pub, pub)).toBe(true);
    // 40-char hex of a hash160 is also valid base64 — the hex reading must still match
    expect(publicKeyDataMatches(toHex(hash), hash)).toBe(true);
    expect(publicKeyDataMatches(toHex(hash), pub)).toBe(false);
    expect(publicKeyDataMatches(undefined, pub)).toBe(false);
  });

  it('reports expected keys missing by ID or data', () => {
    const expected = [
      { id: 0, data: pub },
      { id: 1, data: hash },
    ];
    expect(findMissingIdentityKeys(expected, [
      { keyId: 0, data: toHex(pub) },
      { keyId: 1, data: toHex(hash) },
      { keyId: 2, data: 'ff' },
    ])).toEqual([]);
    expect(findMissingIdentityKeys(expected, [
      { keyId: 0, data: toHex(hash) },
      { keyId: 1, data: toHex(hash) },
    ])).toEqual([0]);
    expect(findMissingIdentityKeys(expected, [{ keyId: 5, data: toHex(pub) }])).toEqual([0, 1]);
  });
});

describe('IdentityRegistrationUnconfirmedError', () => {
  it('is recognisable by name and tells the user retrying is safe', () => {
    const err = new IdentityRegistrationUnconfirmedError('abc123');
    expect(isIdentityRegistrationUnconfirmedError(err)).toBe(true);
    expect(isIdentityRegistrationUnconfirmedError(new Error('other'))).toBe(false);
    expect(err.message).toContain('abc123');
    expect(err.message).toContain('not confirmed it yet');
    expect(err.message).toContain('retry');
  });
});

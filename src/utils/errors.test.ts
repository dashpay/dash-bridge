import { describe, expect, it } from 'vitest';
import { extractErrorMessage } from './errors.js';

class FakeWasmSdkError {
  get name() { return 'Protocol'; }
  get kind() { return 3; }
  get code() { return -1; }
  get message() {
    return 'Invalid document transition id FyhAnUw3WBeK2vUdv99hJke2HZCyGwGePAAaLKYbr2Z5, expected 5Vn5QEoBxmUTUgAvDosnwMFfMzGuqycshTF6LLtuXGcF';
  }
}

describe('extractErrorMessage', () => {
  it('renders a WasmSdkError-like object with its kind instead of [object Object]', () => {
    const message = extractErrorMessage(new FakeWasmSdkError());
    expect(message).toBe(
      'Protocol: Invalid document transition id FyhAnUw3WBeK2vUdv99hJke2HZCyGwGePAAaLKYbr2Z5, expected 5Vn5QEoBxmUTUgAvDosnwMFfMzGuqycshTF6LLtuXGcF'
    );
    expect(message).not.toContain('[object Object]');
  });

  it('appends a present code', () => {
    expect(extractErrorMessage({ name: 'StateTransitionBroadcastError', message: 'Insufficient balance', code: 40100 }))
      .toBe('StateTransitionBroadcastError: Insufficient balance (code 40100)');
  });

  it('keeps standard Error messages unchanged', () => {
    expect(extractErrorMessage(new Error('Identity not found'))).toBe('Identity not found');
    expect(extractErrorMessage(new TypeError('bad'))).toBe('bad');
  });

  it('serializes plain objects without a message', () => {
    expect(extractErrorMessage({ code: 10, details: 'quorum not found', height: 5n }))
      .toBe('{"code":10,"details":"quorum not found","height":"5"}');
  });

  it('falls back for empty or unserializable objects and primitives', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(extractErrorMessage(circular)).toBe('Unknown error');
    expect(extractErrorMessage({})).toBe('Unknown error');
    expect(extractErrorMessage('plain string')).toBe('plain string');
    expect(extractErrorMessage(undefined)).toBe('undefined');
  });
});

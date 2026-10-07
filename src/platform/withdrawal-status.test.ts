import { describe, it, expect } from 'vitest';
import { classifyWithdrawalLookups } from './withdrawal-status.js';

describe('classifyWithdrawalLookups', () => {
  it('any hit means the withdrawal landed', () => {
    expect(classifyWithdrawalLookups(['error', 'found'])).toBe('found');
    expect(classifyWithdrawalLookups(['not_found', 'found', 'error'])).toBe('found');
  });

  it('not found only when the final lookup succeeded with no record', () => {
    expect(classifyWithdrawalLookups(['not_found', 'not_found', 'not_found'])).toBe('not_found');
    expect(classifyWithdrawalLookups(['error', 'error', 'not_found'])).toBe('not_found');
  });

  it('unknown when lookups failed and nothing was found', () => {
    expect(classifyWithdrawalLookups(['error', 'error', 'error'])).toBe('unknown');
    expect(classifyWithdrawalLookups(['not_found', 'not_found', 'error'])).toBe('unknown');
    expect(classifyWithdrawalLookups([])).toBe('unknown');
  });
});

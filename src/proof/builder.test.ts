import { describe, it, expect } from 'vitest';

import { buildChainAssetLockProof, buildInstantAssetLockProof } from './builder.js';

describe('asset lock proof builders', () => {
  it('buildInstantAssetLockProof tags the result as "instant"', () => {
    const tx = new Uint8Array([1, 2, 3]);
    const islock = new Uint8Array([4, 5, 6]);
    const proof = buildInstantAssetLockProof(tx, islock, 0);
    expect(proof.type).toBe('instant');
    if (proof.type !== 'instant') return;
    expect(proof.transactionBytes).toBe(tx);
    expect(proof.instantLockBytes).toBe(islock);
    expect(proof.outputIndex).toBe(0);
  });

  it('buildChainAssetLockProof carries the outpoint + chain-locked height', () => {
    const proof = buildChainAssetLockProof('deadbeef', 1, 12345);
    expect(proof.type).toBe('chain');
    if (proof.type !== 'chain') return;
    expect(proof.txid).toBe('deadbeef');
    expect(proof.vout).toBe(1);
    expect(proof.coreChainLockedHeight).toBe(12345);
  });
});

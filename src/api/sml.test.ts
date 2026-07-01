import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import cbor from 'cbor';

import { decodeSmlDiff } from './sml.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../../scripts/fixtures/sml-paloma-snapshot.bin');

// Fixture is a developer-only devnet snapshot not checked into the repo; skip when absent.
const describeWithFixture = existsSync(FIXTURE) ? describe : describe.skip;

describeWithFixture('decodeSmlDiff', () => {
  let bytes!: Uint8Array;
  beforeAll(() => {
    bytes = new Uint8Array(readFileSync(FIXTURE));
  });

  it('decodes the captured devnet-paloma CBOR snapshot', () => {
    const diff = decodeSmlDiff(bytes);
    expect(diff.nVersion).toBe(1);
    expect(diff.baseBlockHash).toBe(
      '0000000000000000000000000000000000000000000000000000000000000000'
    );
    expect(diff.blockHash).toBe(
      '000003184a3af5ac90b52bb51b80067c7075a50ee930f791854bb020aeb0c93b'
    );
    expect(diff.mnList).toHaveLength(13);
    expect(diff.deletedMNs).toHaveLength(0);
    expect(diff.deletedQuorums).toHaveLength(0);
    expect(diff.newQuorums).toHaveLength(10);
  });

  it('has the expected quorum type distribution (4x101, 2x105, 4x107)', () => {
    const diff = decodeSmlDiff(bytes);
    const counts: Record<number, number> = {};
    for (const q of diff.newQuorums) counts[q.llmqType] = (counts[q.llmqType] || 0) + 1;
    expect(counts[101]).toBe(4);
    expect(counts[105]).toBe(2);
    expect(counts[107]).toBe(4);
  });

  it('parses rotated DIP-0024 quorum fields', () => {
    const diff = decodeSmlDiff(bytes);
    const rotated = diff.newQuorums.filter((q) => q.quorumIndex !== undefined);
    expect(rotated.length).toBeGreaterThan(0);
    for (const q of rotated) {
      expect(q.quorumPublicKey).toHaveLength(96); // 48 bytes hex
      expect(q.quorumSig).toHaveLength(192); // 96 bytes hex
      expect(q.membersSig).toHaveLength(192);
      expect(q.quorumHash).toHaveLength(64);
    }
  });

  it('exposes quorumsCLSigs as { sigHex: indices[] } records', () => {
    const diff = decodeSmlDiff(bytes);
    expect(Array.isArray(diff.quorumsCLSigs)).toBe(true);
    expect(diff.quorumsCLSigs.length).toBeGreaterThan(0);
    for (const entry of diff.quorumsCLSigs) {
      for (const [sig, indices] of Object.entries(entry)) {
        expect(sig).toMatch(/^[0-9a-f]{192}$/);
        expect(Array.isArray(indices)).toBe(true);
        for (const i of indices) expect(typeof i).toBe('number');
      }
    }
  });

  it('carries hex-encoded merkle roots when present', () => {
    const diff = decodeSmlDiff(bytes);
    expect(diff.merkleRootMNList).toMatch(/^[0-9a-f]{64}$/);
    expect(diff.merkleRootQuorums).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws a helpful error when bytes are neither CBOR nor wire-format', () => {
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => decodeSmlDiff(garbage)).toThrow(/decodeSmlDiff: not CBOR/);
  });

  it('reports a distinct diagnosis when CBOR decodes to an unrelated object', () => {
    const wrongShape = new Uint8Array(cbor.encode({ foo: 1, bar: [1, 2, 3] }));
    expect(() => decodeSmlDiff(wrongShape)).toThrow(/missing nVersion or mnList/);
  });
});

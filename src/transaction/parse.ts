import { bytesToHex, reverseBytes } from '../utils/hex.js';
import { hash256 } from '../crypto/hash.js';
import type { CTxOut } from './structures.js';

/** Dash Core MAX_SIZE: upper bound on any compact-size length prefix. */
const MAX_COMPACT_SIZE = 0x02000000;
/** Dash Core MAX_MONEY (21M DASH in duffs). */
const MAX_MONEY = 21_000_000n * 100_000_000n;
/** DIP-2: special transactions carry an extra payload from version 3 on. */
const SPECIAL_TX_MIN_VERSION = 3;

export interface ParsedTransaction {
  version: number;
  txType: number;
  inputCount: number;
  outputs: CTxOut[];
  lockTime: number;
}

class ByteReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private advance(n: number): number {
    if (n > this.remaining) {
      throw new Error('Raw transaction is truncated');
    }
    const start = this.offset;
    this.offset += n;
    return start;
  }

  skip(n: number): void {
    this.advance(n);
  }

  bytesOf(n: number): Uint8Array {
    const start = this.advance(n);
    return this.bytes.slice(start, start + n);
  }

  uint8(): number {
    return this.view.getUint8(this.advance(1));
  }

  uint16(): number {
    return this.view.getUint16(this.advance(2), true);
  }

  uint32(): number {
    return this.view.getUint32(this.advance(4), true);
  }

  int64(): bigint {
    return this.view.getBigInt64(this.advance(8), true);
  }

  /** Read a canonical compact-size integer, as Dash Core's ReadCompactSize does. */
  compactSize(): number {
    const first = this.uint8();
    let n: number;
    let min: number;
    if (first < 253) {
      return first;
    } else if (first === 253) {
      n = this.uint16();
      min = 253;
    } else if (first === 254) {
      n = this.uint32();
      min = 0x10000;
    } else {
      // A canonical 9-byte prefix encodes >= 2^32, which always exceeds MAX_SIZE.
      throw new Error('Raw transaction has an oversized length prefix');
    }
    if (n < min) {
      throw new Error('Raw transaction has a non-canonical length prefix');
    }
    if (n > MAX_COMPACT_SIZE) {
      throw new Error('Raw transaction has an oversized length prefix');
    }
    return n;
  }

  varBytes(): Uint8Array {
    return this.bytesOf(this.compactSize());
  }
}

/**
 * Display-order txid of a raw serialized transaction: the reversed
 * double-SHA256 of all of its bytes (including any DIP-2 extra payload).
 */
export function txidOfRawTransaction(raw: Uint8Array): string {
  return bytesToHex(reverseBytes(hash256(raw)));
}

/**
 * Parse a serialized Dash transaction far enough to read its outputs.
 *
 * Handles DIP-2 special transactions (type in the high 16 bits of the version
 * field, extra payload after the lock time) and requires the whole buffer to
 * be consumed, so a parse cannot silently disagree with the hashed bytes.
 */
export function parseTransaction(raw: Uint8Array): ParsedTransaction {
  const reader = new ByteReader(raw);

  const versionField = reader.uint32();
  const version = (versionField << 16) >> 16; // int16, as in Dash Core
  const txType = versionField >>> 16;

  const inputCount = reader.compactSize();
  for (let i = 0; i < inputCount; i++) {
    reader.skip(32 + 4); // prevout txid + index
    reader.varBytes(); // scriptSig
    reader.skip(4); // sequence
  }

  const outputCount = reader.compactSize();
  const outputs: CTxOut[] = [];
  for (let i = 0; i < outputCount; i++) {
    const value = reader.int64();
    if (value < 0n || value > MAX_MONEY) {
      throw new Error(`Raw transaction output ${i} has an out-of-range value`);
    }
    outputs.push({ value, scriptPubKey: reader.varBytes() });
  }

  const lockTime = reader.uint32();

  if (version >= SPECIAL_TX_MIN_VERSION && txType !== 0) {
    reader.varBytes(); // extra payload
  }

  if (reader.remaining !== 0) {
    throw new Error('Raw transaction has trailing bytes');
  }

  return { version, txType, inputCount, outputs, lockTime };
}

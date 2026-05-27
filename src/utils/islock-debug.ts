/**
 * Best-effort decoding of InstantSend lock (ISLock) bytes for diagnostic logs.
 *
 * Supports both legacy (DIP-22) and DIP-24 layouts:
 *   v1: inputs (vec<OutPoint>) + txid (32) + signature (96)
 *   v2: version (1) + inputs (vec<OutPoint>) + txid (32) + cycleHash (32) + signature (96)
 *
 * All hex values in the returned `parsed` shape use the same byte ordering as
 * dashcore-lib produces for `tx.prevTxId.toString('hex')` and `tx.hash`, so
 * the caller can compare them directly.
 */

import { bytesToHex, reverseBytes } from './hex.js';

export interface IslockInputRef {
  txid: string;
  vout: number;
}

export interface ParsedIslock {
  version: 'v1' | 'v2';
  txid: string;
  cycleHash?: string;
  inputs: IslockInputRef[];
  signatureHex: string;
}

export interface IslockDebug {
  context: string;
  byteLength: number;
  hex: string;
  parsed?: ParsedIslock;
  parseError?: string;
}

export interface IslockInputDiff {
  matches: boolean;
  details: string[];
}

/**
 * Produce a structured, log-friendly summary of an ISLock blob.
 *
 * Never throws — failed parses are surfaced via `parseError` so debug logs
 * keep flowing even when the bytes are malformed or come from a future
 * ISLock variant.
 */
export function describeIslock(bytes: Uint8Array, context: string): IslockDebug {
  const summary: IslockDebug = {
    context,
    byteLength: bytes.length,
    hex: bytesToHex(bytes),
  };

  try {
    summary.parsed = parseIslock(bytes);
  } catch (err) {
    summary.parseError = err instanceof Error ? err.message : String(err);
  }

  return summary;
}

/**
 * Compare the set of inputs covered by an ISLock against the inputs of the
 * locked transaction. Order does not matter; we look for a one-to-one match
 * by (txid, vout). Returns human-readable details suitable for logging.
 */
export function diffIslockInputsAgainstTx(
  islockInputs: IslockInputRef[],
  txInputs: IslockInputRef[]
): IslockInputDiff {
  const details: string[] = [];
  const islockSet = new Set(islockInputs.map(keyOf));
  const txSet = new Set(txInputs.map(keyOf));

  if (islockInputs.length !== txInputs.length) {
    details.push(
      `input count mismatch: islock=${islockInputs.length} tx=${txInputs.length}`
    );
  }

  for (const key of islockSet) {
    if (!txSet.has(key)) {
      details.push(`islock input not in tx: ${key}`);
    }
  }
  for (const key of txSet) {
    if (!islockSet.has(key)) {
      details.push(`tx input not in islock: ${key}`);
    }
  }

  return { matches: details.length === 0, details };
}

function keyOf(input: IslockInputRef): string {
  return `${input.txid}:${input.vout}`;
}

/**
 * Try parsing as DIP-24 (v2) first, falling back to DIP-22 (v1). The two
 * formats are distinguished only by total length, so we pick whichever
 * leaves exactly 96 bytes (BLS signature) at the tail.
 */
function parseIslock(bytes: Uint8Array): ParsedIslock {
  // v2 has a leading version byte (currently 1).
  if (bytes.length > 0 && bytes[0] === 1) {
    try {
      return parseV2(bytes);
    } catch {
      // fall through to v1
    }
  }
  return parseV1(bytes);
}

function parseV2(bytes: Uint8Array): ParsedIslock {
  const reader = new ByteReader(bytes);
  const version = reader.readUint8();
  if (version !== 1) {
    throw new Error(`unexpected v2 version byte: ${version}`);
  }
  const inputs = readInputs(reader);
  const txidBytes = reader.readBytes(32);
  const cycleHashBytes = reader.readBytes(32);
  const signatureBytes = reader.readBytes(96);
  if (!reader.atEnd()) {
    throw new Error(`v2 parse left ${reader.remaining()} trailing bytes`);
  }
  return {
    version: 'v2',
    txid: bytesToHex(reverseBytes(txidBytes)),
    cycleHash: bytesToHex(reverseBytes(cycleHashBytes)),
    inputs,
    signatureHex: bytesToHex(signatureBytes),
  };
}

function parseV1(bytes: Uint8Array): ParsedIslock {
  const reader = new ByteReader(bytes);
  const inputs = readInputs(reader);
  const txidBytes = reader.readBytes(32);
  const signatureBytes = reader.readBytes(96);
  if (!reader.atEnd()) {
    throw new Error(`v1 parse left ${reader.remaining()} trailing bytes`);
  }
  return {
    version: 'v1',
    txid: bytesToHex(reverseBytes(txidBytes)),
    inputs,
    signatureHex: bytesToHex(signatureBytes),
  };
}

function readInputs(reader: ByteReader): IslockInputRef[] {
  const count = reader.readVarInt();
  if (count > 10_000) {
    throw new Error(`implausible islock input count: ${count}`);
  }
  const inputs: IslockInputRef[] = [];
  for (let i = 0; i < count; i++) {
    // OutPoint serialization uses wire-order (LE) txid bytes followed by
    // a 4-byte LE vout. dashcore-lib's tx.inputs[i].prevTxId Buffer is also
    // in wire order, so we hex-encode without reversing to keep them
    // comparable.
    const txid = bytesToHex(reader.readBytes(32));
    const vout = reader.readUint32LE();
    inputs.push({ txid, vout });
  }
  return inputs;
}

class ByteReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  readUint8(): number {
    this.ensure(1);
    return this.bytes[this.offset++];
  }

  readUint32LE(): number {
    this.ensure(4);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
    const value = view.getUint32(0, true);
    this.offset += 4;
    return value;
  }

  readBytes(n: number): Uint8Array {
    this.ensure(n);
    const slice = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  readVarInt(): number {
    const first = this.readUint8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      this.ensure(2);
      const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
      this.offset += 2;
      return value;
    }
    if (first === 0xfe) {
      return this.readUint32LE();
    }
    // 0xff: 8-byte varint — JS number safe up to 2^53, but anything this
    // big is nonsense for an islock input count anyway.
    this.ensure(8);
    const low = this.readUint32LE();
    const high = this.readUint32LE();
    if (high !== 0) {
      throw new Error('varint exceeds safe integer range');
    }
    return low;
  }

  atEnd(): boolean {
    return this.offset === this.bytes.length;
  }

  remaining(): number {
    return this.bytes.length - this.offset;
  }

  private ensure(n: number): void {
    if (this.offset + n > this.bytes.length) {
      throw new Error(
        `unexpected end of islock bytes (need ${n} at offset ${this.offset}, length ${this.bytes.length})`
      );
    }
  }
}

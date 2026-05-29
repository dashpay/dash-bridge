/* eslint-disable @typescript-eslint/no-explicit-any */

import dashcoreLib from '@dashevo/dashcore-lib';
import { bytesToHex } from './hex.js';

const InstantLock = (dashcoreLib as any).InstantLock;

export interface IslockDebugInfo {
  source: string;
  byteLength: number;
  islockHex: string;
  parsed?: {
    version: number | undefined;
    txid: string;
    cyclehash?: string;
    signatureHex: string;
    signatureLength: number;
    inputs: Array<{ outpointHash: string; outpointIndex: number }>;
    requestIdHex: string;
    islockHashHex: string;
  };
  parseError?: string;
}

/**
 * Parse an IS lock and produce a structured debug record covering every
 * field that the platform uses when verifying the IS lock signature
 * (request id, sign hash inputs, signature bytes, cycle hash).
 */
export function describeIslock(islockBytes: Uint8Array, source: string): IslockDebugInfo {
  const islockHex = bytesToHex(islockBytes);
  const info: IslockDebugInfo = {
    source,
    byteLength: islockBytes.length,
    islockHex,
  };

  try {
    const lock = InstantLock.fromBuffer(Buffer.from(islockBytes));
    const requestId: Buffer = lock.getRequestId();
    const islockHash: Buffer = lock.getHash();
    const signature: string =
      typeof lock.signature === 'string'
        ? lock.signature
        : Buffer.from(lock.signature).toString('hex');

    info.parsed = {
      version: lock.version,
      txid: lock.txid,
      cyclehash: lock.cyclehash,
      signatureHex: signature,
      signatureLength: Math.floor(signature.length / 2),
      inputs: (lock.inputs || []).map((i: any) => ({
        outpointHash: i.outpointHash,
        outpointIndex: i.outpointIndex,
      })),
      requestIdHex: requestId.toString('hex'),
      islockHashHex: islockHash.toString('hex'),
    };
  } catch (err) {
    info.parseError = err instanceof Error ? err.message : String(err);
  }

  return info;
}

/**
 * Compare IS lock inputs against the transaction inputs (in display order
 * txid:vout). Returns mismatches so the caller can flag malformed locks.
 */
export function diffIslockInputsAgainstTx(
  parsedIslockInputs: Array<{ outpointHash: string; outpointIndex: number }>,
  txInputs: Array<{ txid: string; vout: number }>
): { matches: boolean; details: string[] } {
  const details: string[] = [];
  if (parsedIslockInputs.length !== txInputs.length) {
    details.push(
      `input count differs: islock=${parsedIslockInputs.length} tx=${txInputs.length}`
    );
  }
  const len = Math.min(parsedIslockInputs.length, txInputs.length);
  for (let i = 0; i < len; i++) {
    const lockIn = parsedIslockInputs[i];
    const txIn = txInputs[i];
    if (lockIn.outpointHash !== txIn.txid || lockIn.outpointIndex !== txIn.vout) {
      details.push(
        `input[${i}] mismatch: islock=${lockIn.outpointHash}:${lockIn.outpointIndex} tx=${txIn.txid}:${txIn.vout}`
      );
    }
  }
  return { matches: details.length === 0, details };
}

import { concatBytes, hexToBytes, reverseBytes } from '../utils/hex.js';
import { hash160 } from '../crypto/hash.js';
import { txidOfRawTransaction } from './parse.js';
import {
  serCompactSize,
  serString,
  serInt32,
  serUint32,
} from './serialize.js';
import {
  type COutPoint,
  type CTxIn,
  type CTxOut,
  type CAssetLockPayload,
  serializeTxIn,
  serializeTxOut,
  serializeAssetLockPayload,
  createP2PKHScript,
  createOpReturnScript,
} from './structures.js';
import type { AuthenticatedUtxo, UTXO } from '../types.js';

const TX_VERSION = 3;
const TX_TYPE_ASSET_LOCK = 8;

/**
 * Hard ceiling on the implicit fee (inputs minus outputs) of any asset lock
 * we build or sign. assetLockFee stays below it up to MAX_ASSET_LOCK_INPUTS;
 * anything above means a bug or a misreported input value.
 */
export const MAX_ASSET_LOCK_FEE = 10_000n;

export interface AssetLockTransaction {
  version: number;
  txType: number;
  vin: CTxIn[];
  vout: CTxOut[];
  lockTime: number;
  extraPayload: Uint8Array;
}

/**
 * Serialize a complete transaction
 */
export function serializeTransaction(tx: AssetLockTransaction): Uint8Array {
  const parts: Uint8Array[] = [];

  // Version with type: version | (type << 16)
  const ver32bit = tx.version | (tx.txType << 16);
  parts.push(serInt32(ver32bit));

  // Inputs
  parts.push(serCompactSize(tx.vin.length));
  for (const vin of tx.vin) {
    parts.push(serializeTxIn(vin));
  }

  // Outputs
  parts.push(serCompactSize(tx.vout.length));
  for (const vout of tx.vout) {
    parts.push(serializeTxOut(vout));
  }

  // Lock time
  parts.push(serUint32(tx.lockTime));

  // Extra payload for special transactions
  if (tx.txType !== 0 && tx.extraPayload.length > 0) {
    parts.push(serString(tx.extraPayload));
  }

  return concatBytes(...parts);
}

/**
 * Calculate transaction ID (reversed hash256 of serialized tx)
 */
export function calculateTxId(tx: AssetLockTransaction): string {
  return txidOfRawTransaction(serializeTransaction(tx));
}

/** Dash Core's default minimum relay fee: 1000 duffs per kB. */
const MIN_RELAY_FEE_PER_BYTE = 1n;

/**
 * Largest signed P2PKH input: 36 outpoint + 1 + 107 scriptSig + 4 sequence.
 * The scriptSig bound assumes signHash's low-S DER signatures (at most 71 bytes).
 */
const MAX_P2PKH_INPUT_SIZE = 148n;

/** Everything but the inputs: version, counts, OP_RETURN output, locktime, payload. */
const ASSET_LOCK_BASE_SIZE = 57n;

/**
 * Most coins one asset lock spends, so its relay fee stays under
 * MAX_ASSET_LOCK_FEE.
 */
export const MAX_ASSET_LOCK_INPUTS = 60;

/**
 * Fee for an asset lock spending `inputCount` coins: the configured fee, or
 * the minimum relay fee for the signed size if that is higher.
 */
export function assetLockFee(inputCount: number, minFee: bigint): bigint {
  const size = ASSET_LOCK_BASE_SIZE + BigInt(inputCount) * MAX_P2PKH_INPUT_SIZE;
  const relayFee = size * MIN_RELAY_FEE_PER_BYTE;
  return relayFee > minFee ? relayFee : minFee;
}

function outpointKey(utxo: UTXO): string {
  return `${utxo.txid.toLowerCase()}:${utxo.vout}`;
}

/**
 * Coins a deposit's asset lock spends: all distinct outpoints, or the largest
 * MAX_ASSET_LOCK_INPUTS if there are more.
 */
export function selectDepositUtxos<T extends UTXO>(utxos: T[]): T[] {
  const unique = new Map(utxos.map((u) => [outpointKey(u), u]));
  return [...unique.values()].sort((a, b) => b.satoshis - a.satoshis).slice(0, MAX_ASSET_LOCK_INPUTS);
}

/**
 * Create an unsigned asset lock transaction that spends every given UTXO and
 * locks their total minus the fee (see assetLockFee).
 */
export function createAssetLockTransaction(
  utxos: AuthenticatedUtxo[],
  assetLockPubKey: Uint8Array,
  minFee: bigint = 1000n
): AssetLockTransaction {
  if (minFee <= 0n || minFee > MAX_ASSET_LOCK_FEE) {
    throw new Error(`Asset lock fee ${minFee} is outside (0, ${MAX_ASSET_LOCK_FEE}] duffs`);
  }
  if (utxos.length === 0 || utxos.length > MAX_ASSET_LOCK_INPUTS) {
    throw new Error(`An asset lock spends 1 to ${MAX_ASSET_LOCK_INPUTS} UTXOs, got ${utxos.length}`);
  }
  const outpoints = new Set<string>();
  for (const utxo of utxos) {
    if (!Number.isSafeInteger(utxo.satoshis) || utxo.satoshis <= 0) {
      throw new Error('Invalid UTXO amount for asset lock');
    }
    const outpoint = outpointKey(utxo);
    if (outpoints.has(outpoint)) {
      throw new Error(`UTXO ${outpoint} is listed twice`);
    }
    outpoints.add(outpoint);
  }

  const fee = assetLockFee(utxos.length, minFee);
  const lockAmount = utxos.reduce((sum, u) => sum + BigInt(u.satoshis), 0n) - fee;

  if (lockAmount <= 0n) {
    throw new Error('Insufficient funds for asset lock');
  }

  // TXID from Insight is in display order (big-endian), reverse for internal order
  const vin: CTxIn[] = utxos.map((utxo) => ({
    prevout: {
      txid: reverseBytes(hexToBytes(utxo.txid)),
      n: utxo.vout,
    } as COutPoint,
    scriptSig: new Uint8Array(0), // Will be filled after signing
    sequence: 0xffffffff,
  }));

  // Create burn output (OP_RETURN with the locked amount)
  const burnOutput: CTxOut = {
    value: lockAmount,
    scriptPubKey: createOpReturnScript(),
  };

  const vout: CTxOut[] = [burnOutput];

  // Create the asset lock payload with credit output
  const pubKeyHash = hash160(assetLockPubKey);
  const creditOutput: CTxOut = {
    value: lockAmount,
    scriptPubKey: createP2PKHScript(pubKeyHash),
  };

  const payload: CAssetLockPayload = {
    version: 1,
    creditOutputs: [creditOutput],
  };

  const tx: AssetLockTransaction = {
    version: TX_VERSION,
    txType: TX_TYPE_ASSET_LOCK,
    vin,
    vout,
    lockTime: 0,
    extraPayload: serializeAssetLockPayload(payload),
  };

  const actualFee = implicitFee(tx, utxos);
  if (actualFee !== fee) {
    throw new Error(`Asset lock fee mismatch: built ${actualFee}, expected ${fee} duffs`);
  }

  return tx;
}

/**
 * Implicit fee of a transaction: the spent UTXOs' values minus its outputs.
 */
export function implicitFee(tx: AssetLockTransaction, utxos: UTXO[]): bigint {
  const inputs = utxos.reduce((sum, u) => sum + BigInt(u.satoshis), 0n);
  const outputs = tx.vout.reduce((sum, o) => sum + o.value, 0n);
  return inputs - outputs;
}

/**
 * Clone a transaction (deep copy)
 */
export function cloneTransaction(
  tx: AssetLockTransaction
): AssetLockTransaction {
  return {
    version: tx.version,
    txType: tx.txType,
    vin: tx.vin.map((vin) => ({
      prevout: {
        txid: new Uint8Array(vin.prevout.txid),
        n: vin.prevout.n,
      },
      scriptSig: new Uint8Array(vin.scriptSig),
      sequence: vin.sequence,
    })),
    vout: tx.vout.map((vout) => ({
      value: vout.value,
      scriptPubKey: new Uint8Array(vout.scriptPubKey),
    })),
    lockTime: tx.lockTime,
    extraPayload: new Uint8Array(tx.extraPayload),
  };
}

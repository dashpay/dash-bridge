import { concatBytes, hexToBytes, reverseBytes } from '../utils/hex.js';
import { hash160, hash256 } from '../crypto/hash.js';
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
 * we build or sign. The configured fee is 1000 duffs; anything above this
 * means a bug or a misreported input value, never a legitimate fee.
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
  const serialized = serializeTransaction(tx);
  const hash = hash256(serialized);
  return Array.from(reverseBytes(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Create an unsigned asset lock transaction
 */
export function createAssetLockTransaction(
  utxo: AuthenticatedUtxo,
  assetLockPubKey: Uint8Array,
  fee: bigint = 1000n
): AssetLockTransaction {
  if (fee <= 0n || fee > MAX_ASSET_LOCK_FEE) {
    throw new Error(`Asset lock fee ${fee} is outside (0, ${MAX_ASSET_LOCK_FEE}] duffs`);
  }
  if (!Number.isSafeInteger(utxo.satoshis) || utxo.satoshis <= 0) {
    throw new Error('Invalid UTXO amount for asset lock');
  }

  // Calculate values
  const utxoAmount = BigInt(utxo.satoshis);
  const lockAmount = utxoAmount - fee;

  if (lockAmount <= 0n) {
    throw new Error('Insufficient funds for asset lock');
  }

  // Create input from UTXO
  // TXID from Insight is in display order (big-endian), reverse for internal order
  const txidBytes = reverseBytes(hexToBytes(utxo.txid));

  const vin: CTxIn[] = [
    {
      prevout: {
        txid: txidBytes,
        n: utxo.vout,
      } as COutPoint,
      scriptSig: new Uint8Array(0), // Will be filled after signing
      sequence: 0xffffffff,
    },
  ];

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

  const actualFee = implicitFee(tx, [utxo]);
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

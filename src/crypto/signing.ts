import * as secp256k1 from '@noble/secp256k1';
import { bytesToHex, concatBytes, reverseBytes } from '../utils/hex.js';
import {
  type AssetLockTransaction,
  implicitFee,
  MAX_ASSET_LOCK_FEE,
} from '../transaction/builder.js';
import { signatureHash, getScriptCodeFromUtxo, SIGHASH_ALL } from '../transaction/sighash.js';
import type { AuthenticatedUtxo, UTXO } from '../types.js';

/**
 * Encode a big integer as a DER integer
 */
function derEncodeInteger(n: bigint): Uint8Array {
  // Convert to bytes (big-endian)
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;

  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }

  // Add leading zero if high bit is set (to keep positive)
  if (bytes[0] >= 0x80) {
    bytes.unshift(0x00);
  }

  // DER INTEGER tag (0x02) + length + bytes
  return new Uint8Array([0x02, bytes.length, ...bytes]);
}

/**
 * Encode signature as DER format
 * DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
 */
function signatureToDER(r: bigint, s: bigint): Uint8Array {
  const rEncoded = derEncodeInteger(r);
  const sEncoded = derEncodeInteger(s);

  const totalLength = rEncoded.length + sEncoded.length;

  return concatBytes(
    new Uint8Array([0x30, totalLength]),
    rEncoded,
    sEncoded
  );
}

/**
 * Sign a message hash and return DER-encoded signature with sighash byte appended
 */
export async function signHash(
  hash: Uint8Array,
  privateKey: Uint8Array
): Promise<Uint8Array> {
  // Sign with lowS normalization (BIP-62)
  const sig = await secp256k1.signAsync(hash, privateKey, { lowS: true });

  // Convert to DER format
  const derSig = signatureToDER(sig.r, sig.s);

  // Append SIGHASH_ALL (0x01)
  return concatBytes(derSig, new Uint8Array([SIGHASH_ALL]));
}

/**
 * Create a P2PKH scriptSig: <sig> <pubkey>
 */
export function createP2PKHScriptSig(
  signature: Uint8Array,
  publicKey: Uint8Array
): Uint8Array {
  // Push signature length, signature, push pubkey length, pubkey
  return concatBytes(
    new Uint8Array([signature.length]),
    signature,
    new Uint8Array([publicKey.length]),
    publicKey
  );
}

/**
 * Sign a transaction input and return the signed transaction
 */
export async function signTransactionInput(
  tx: AssetLockTransaction,
  inputIndex: number,
  utxo: UTXO,
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Promise<AssetLockTransaction> {
  // Get the scriptCode (scriptPubKey of the output being spent)
  const scriptCode = getScriptCodeFromUtxo(utxo);

  // Calculate signature hash
  const sighash = signatureHash(tx, inputIndex, scriptCode);

  // Sign the hash
  const signature = await signHash(sighash, privateKey);

  // Create scriptSig
  const scriptSig = createP2PKHScriptSig(signature, publicKey);

  // Create new transaction with scriptSig filled in
  const signedTx: AssetLockTransaction = {
    ...tx,
    vin: tx.vin.map((vin, i) =>
      i === inputIndex
        ? { ...vin, scriptSig }
        : vin
    ),
  };

  return signedTx;
}

/**
 * Sign all inputs of a transaction (assumes all inputs use the same key)
 */
export async function signTransaction(
  tx: AssetLockTransaction,
  utxos: AuthenticatedUtxo[],
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Promise<AssetLockTransaction> {
  // Legacy sighash does not commit to input values. Amount authenticity comes
  // from authenticateUtxo; this is a backstop that requires one matching UTXO
  // per input and a bounded implicit fee.
  if (utxos.length !== tx.vin.length) {
    throw new Error(`Expected ${tx.vin.length} UTXOs to sign, got ${utxos.length}`);
  }
  tx.vin.forEach((vin, i) => {
    const prevTxid = bytesToHex(reverseBytes(vin.prevout.txid));
    if (prevTxid !== utxos[i].txid.toLowerCase() || vin.prevout.n !== utxos[i].vout) {
      throw new Error(`UTXO ${i} does not match the input it would sign`);
    }
  });
  const fee = implicitFee(tx, utxos);
  if (fee <= 0n || fee > MAX_ASSET_LOCK_FEE) {
    throw new Error(`Refusing to sign: implicit fee ${fee} duffs is outside (0, ${MAX_ASSET_LOCK_FEE}]`);
  }

  let signedTx = tx;

  for (let i = 0; i < tx.vin.length; i++) {
    signedTx = await signTransactionInput(
      signedTx,
      i,
      utxos[i],
      privateKey,
      publicKey
    );
  }

  return signedTx;
}

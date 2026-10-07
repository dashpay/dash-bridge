import { bytesToHex } from '../utils/hex.js';
import { hash160 } from '../crypto/hash.js';
import { createP2PKHScript } from './structures.js';
import { parseTransaction, txidOfRawTransaction } from './parse.js';
import type { AuthenticatedUtxo, UTXO } from '../types.js';

const TXID_RE = /^[0-9a-f]{64}$/i;

/**
 * The explorer's view of a deposit could not be confirmed against the raw
 * previous transaction. Nothing has been signed; the deposit is untouched.
 */
export class UtxoAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UtxoAuthenticationError';
  }
}

/** Throw unless `txid` is a 64-character hex string. */
export function assertTxid(txid: unknown): asserts txid is string {
  if (typeof txid !== 'string' || !TXID_RE.test(txid)) {
    throw new UtxoAuthenticationError('Explorer returned a malformed deposit txid');
  }
}

/**
 * Authenticate an explorer-reported UTXO against the raw bytes of the
 * transaction that created it.
 *
 * Dash's legacy sighash does not commit to input amounts, so signing over an
 * understated value would silently turn the difference into miner fee. This
 * check makes the amount and script we sign come from bytes whose hash is the
 * outpoint's txid, not from explorer JSON.
 *
 * Returns the UTXO with value and scriptPubKey taken from the raw transaction.
 * Throws {@link UtxoAuthenticationError} if the bytes do not hash to the txid,
 * the output does not exist, it does not pay the deposit key's P2PKH script,
 * or the explorer's reported amount or script disagrees with the raw output.
 */
export function authenticateUtxo(
  utxo: UTXO,
  rawTx: Uint8Array,
  depositPublicKey: Uint8Array
): AuthenticatedUtxo {
  assertTxid(utxo.txid);
  const txid = utxo.txid.toLowerCase();

  if (!Number.isSafeInteger(utxo.vout) || utxo.vout < 0) {
    throw new UtxoAuthenticationError('Explorer returned a malformed deposit output index');
  }

  if (txidOfRawTransaction(rawTx) !== txid) {
    throw new UtxoAuthenticationError(
      `Raw transaction from the explorer does not match deposit txid ${txid}`
    );
  }

  let outputs;
  try {
    outputs = parseTransaction(rawTx).outputs;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UtxoAuthenticationError(`Could not parse deposit transaction ${txid}: ${reason}`);
  }

  const output = outputs[utxo.vout];
  if (!output) {
    throw new UtxoAuthenticationError(
      `Deposit transaction ${txid} has no output ${utxo.vout} (it has ${outputs.length})`
    );
  }

  const expectedScript = bytesToHex(createP2PKHScript(hash160(depositPublicKey)));
  const scriptPubKey = bytesToHex(output.scriptPubKey);
  if (scriptPubKey !== expectedScript) {
    throw new UtxoAuthenticationError(
      `Deposit output ${txid}:${utxo.vout} does not pay this bridge's deposit address`
    );
  }

  const satoshis = Number(output.value);
  if (utxo.satoshis !== satoshis) {
    throw new UtxoAuthenticationError(
      `Explorer reported ${utxo.satoshis} duffs for deposit ${txid}:${utxo.vout}, ` +
        `but the transaction itself says ${satoshis}. Refusing to continue; ` +
        'your funds are safe at the deposit address. Try again later.'
    );
  }
  if (typeof utxo.scriptPubKey !== 'string' || utxo.scriptPubKey.toLowerCase() !== scriptPubKey) {
    throw new UtxoAuthenticationError(
      `Explorer reported a different script for deposit ${txid}:${utxo.vout} than the transaction itself`
    );
  }

  return { ...utxo, txid, satoshis, scriptPubKey } as AuthenticatedUtxo;
}

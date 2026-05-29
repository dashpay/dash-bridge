import type { AssetLockProofData } from '../types.js';

/**
 * Build an instant-lock AssetLockProofData from a signed tx + islock.
 *
 * @param transactionBytes - Serialized signed transaction
 * @param instantLockBytes - Serialized InstantSend lock message
 * @param outputIndex - Index of the burn output (usually 0)
 */
export function buildInstantAssetLockProof(
  transactionBytes: Uint8Array,
  instantLockBytes: Uint8Array,
  outputIndex: number = 0
): Extract<AssetLockProofData, { type: 'instant' }> {
  return {
    type: 'instant',
    transactionBytes,
    instantLockBytes,
    outputIndex,
  };
}

/**
 * Build a chain-lock AssetLockProofData from the asset lock outpoint and the
 * Platform-known chain-locked tip. Platform accepts this in place of an
 * InstantSend proof once the confirming block is buried under a chain lock.
 *
 * @param txid - Asset lock transaction id (hex)
 * @param vout - Output index of the burn output (usually 0)
 * @param coreChainLockedHeight - Platform-reported chain-locked tip; must be
 *   >= the block height that confirmed the asset lock tx.
 */
export function buildChainAssetLockProof(
  txid: string,
  vout: number,
  coreChainLockedHeight: number
): AssetLockProofData {
  return {
    type: 'chain',
    coreChainLockedHeight,
    txid,
    vout,
  };
}

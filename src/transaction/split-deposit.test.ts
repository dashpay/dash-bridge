import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateKeyPair } from '../crypto/keys.js';
import { hash160 } from '../crypto/hash.js';
import { signTransaction } from '../crypto/signing.js';
import { InsightClient } from '../api/insight.js';
import { TESTNET } from '../config.js';
import { bytesToHex, reverseBytes } from '../utils/hex.js';
import {
  MAX_ASSET_LOCK_FEE,
  MAX_ASSET_LOCK_INPUTS,
  assetLockFee,
  createAssetLockTransaction,
  implicitFee,
  selectDepositUtxos,
  serializeTransaction,
} from './builder.js';
import { createP2PKHScript } from './structures.js';
import type { AuthenticatedUtxo, UTXO } from '../types.js';

const keyPair = generateKeyPair();
const script = bytesToHex(createP2PKHScript(hash160(keyPair.publicKey)));

function coin(i: number, satoshis: number): AuthenticatedUtxo {
  return {
    txid: i.toString(16).padStart(64, '0'),
    vout: i % 3,
    satoshis,
    scriptPubKey: script,
    confirmations: 0,
  } as AuthenticatedUtxo;
}

function coins(amounts: number[]): AuthenticatedUtxo[] {
  return amounts.map((satoshis, i) => coin(i + 1, satoshis));
}

function waitWith(utxos: UTXO[], minAmount: number) {
  const client = new InsightClient(TESTNET);
  vi.spyOn(client, 'getUTXOs').mockResolvedValue(utxos);
  return client.waitForUtxo('yDeposit', minAmount, 200, 10);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('split deposits (#42)', () => {
  const cases: Array<[string, number[]]> = [
    ['single coin', [400000]],
    ['two coins', [200000, 200000]],
    ['many coins', [50000, 30000, 70000, 25000, 40000, 35000, 20000, 15000, 10000, 5000]],
  ];

  for (const [name, amounts] of cases) {
    it(`${name}: every coin is detected, spent and signed`, async () => {
      const deposit = coins(amounts);
      const total = amounts.reduce((a, b) => a + b, 0);

      const result = await waitWith(deposit, 300000);
      expect(result.timedOut).toBe(false);
      expect(result.totalAmount).toBe(total);
      expect(result.utxos).toHaveLength(amounts.length);
      expect(new Set(result.utxos)).toEqual(new Set(deposit));

      const spent = result.utxos as AuthenticatedUtxo[];
      const tx = createAssetLockTransaction(spent, keyPair.publicKey, 1000n);
      const fee = assetLockFee(amounts.length, 1000n);
      expect(tx.vin).toHaveLength(amounts.length);
      expect(tx.vin.map((v) => `${bytesToHex(reverseBytes(v.prevout.txid))}:${v.prevout.n}`)).toEqual(
        spent.map((u) => `${u.txid}:${u.vout}`)
      );
      expect(tx.vout.map((o) => o.value)).toEqual([BigInt(total) - fee]);
      expect(implicitFee(tx, spent)).toBe(fee);

      const signed = await signTransaction(tx, spent, keyPair.privateKey, keyPair.publicKey);
      expect(signed.vin.every((v) => v.scriptSig.length > 100)).toBe(true);
      // The fee covers Dash Core's 1 duff/byte minimum relay fee for the signed size.
      expect(BigInt(serializeTransaction(signed).length)).toBeLessThanOrEqual(fee);
    });
  }

  it('the issue repro: two 200k coins against a 300k minimum lock 399000, not 199000', async () => {
    const result = await waitWith(coins([200000, 200000]), 300000);
    const tx = createAssetLockTransaction(result.utxos as AuthenticatedUtxo[], keyPair.publicKey, 1000n);
    expect(tx.vout[0].value).toBe(399000n);
  });

  it('keeps waiting while the coins together are below the minimum', async () => {
    const result = await waitWith(coins([100000, 100000]), 300000);
    expect(result).toEqual({ utxos: null, totalAmount: 200000, timedOut: true });
  });

  it('keeps the configured fee for small locks and raises it with the size for big ones', () => {
    expect(assetLockFee(1, 1000n)).toBe(1000n);
    expect(assetLockFee(6, 1000n)).toBe(1000n);
    expect(assetLockFee(7, 1000n)).toBeGreaterThan(1000n);
    expect(assetLockFee(MAX_ASSET_LOCK_INPUTS, 1000n)).toBeLessThanOrEqual(MAX_ASSET_LOCK_FEE);
  });

  it('signs a lock at the input cap within the fee bound', async () => {
    const deposit = coins(Array.from({ length: MAX_ASSET_LOCK_INPUTS }, () => 10000));
    const tx = createAssetLockTransaction(deposit, keyPair.publicKey, 1000n);
    const signed = await signTransaction(tx, deposit, keyPair.privateKey, keyPair.publicKey);
    expect(BigInt(serializeTransaction(signed).length)).toBeLessThanOrEqual(implicitFee(tx, deposit));
  });

  it('spends the largest coins when there are more than one lock can carry', async () => {
    const amounts = Array.from({ length: MAX_ASSET_LOCK_INPUTS + 5 }, (_, i) => 10000 + i);
    const deposit = coins(amounts);
    expect(selectDepositUtxos(deposit).map((u) => u.satoshis)).toEqual(
      [...amounts].sort((a, b) => b - a).slice(0, MAX_ASSET_LOCK_INPUTS)
    );
    expect(() => createAssetLockTransaction(deposit, keyPair.publicKey, 1000n)).toThrow(/1 to 60 UTXOs/);

    // The minimum applies to what the lock can actually spend.
    const smallest5 = amounts.slice(0, 5).reduce((a, b) => a + b, 0);
    const total = amounts.reduce((a, b) => a + b, 0);
    const result = await waitWith(deposit, total - smallest5 + 1);
    expect(result.utxos).toBeNull();
    // The timeout reports what is spendable, so the UI asks for more instead of "nothing detected".
    expect(result.totalAmount).toBe(total - smallest5);
  });

  it('counts a coin Insight lists twice only once', async () => {
    const [a, b] = coins([200000, 150000]);
    const result = await waitWith([a, b, { ...a, txid: a.txid.toUpperCase() }], 300000);
    expect(result.utxos).toEqual([a, b]);
    expect(result.totalAmount).toBe(350000);
  });

  it('rejects an empty or duplicated coin list', () => {
    expect(() => createAssetLockTransaction([], keyPair.publicKey, 1000n)).toThrow(/got 0/);
    const c = coin(1, 200000);
    expect(() => createAssetLockTransaction([c, { ...c }], keyPair.publicKey, 1000n)).toThrow(/listed twice/);
  });
});

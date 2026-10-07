import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateKeyPair } from '../crypto/keys.js';
import { hash160 } from '../crypto/hash.js';
import { signTransaction } from '../crypto/signing.js';
import { InsightClient } from '../api/insight.js';
import { TESTNET } from '../config.js';
import { bytesToHex, hexToBytes } from '../utils/hex.js';
import {
  type AssetLockTransaction,
  MAX_ASSET_LOCK_FEE,
  calculateTxId,
  createAssetLockTransaction,
  serializeTransaction,
} from './builder.js';
import { createP2PKHScript } from './structures.js';
import { parseTransaction, txidOfRawTransaction } from './parse.js';
import { UtxoAuthenticationError, authenticateUtxo } from './utxo-auth.js';
import type { AuthenticatedUtxo, UTXO } from '../types.js';

/**
 * Real Dash testnet transactions, fetched from
 * https://insight.testnet.networks.dash.org/insight-api/rawtx/{txid}.
 * Each test re-derives the txid from the bytes, so the fixtures are
 * self-verifying.
 */
const FIXTURES = {
  // Ordinary version-2 payment: 2 inputs, 2 P2PKH outputs (block 1567774).
  normal: {
    txid: '017396bfd57b94530884cc396840e343961898dacf2602427975f69124677588',
    hex:
      '0200000002366af3d054439cacbc8668c6d843cdb80886a671216243c8556deae1e1bf686c010000006a473044022018a71ae91adab1c5d539f80c2457f93a127919c089528028d17cf8e53bcd7c0e02204dbc1c1922bb4d386863f8a9970c8bc1a25b072b6192a377bae99cb93ee1888481210296f2e9224f07734b93faf4d8602b840156ce44ca4a00270c3065588bc47d8051ffffffff0cdeedf74b788b7e35164abf185ef4b459c6b71438ffc3d9b6797728c7e0f696020000006a4730440220731bc7d53503e5d810bcf4eadb9083f1cfc7f1327e25d129c18bcc0bc873dd4b02206518afb60eeb87613e5543177f4d48c0a36ea3e58573673ff6b576d9a46c669a812102228688c23036720152a040f62fe49bdd64687aebd4c9b18b0df0c56c03d2e623ffffffff0210f19a3b000000001976a9142fb0e69cb01a5bfbc0177fe54601e6ea3b052c4a88ac10f19a3b000000001976a914f94983b92eec64266a9dbcb6b3af6adb06824d0788ac00000000',
    version: 2,
    txType: 0,
    outputs: [
      [1000010000n, '76a9142fb0e69cb01a5bfbc0177fe54601e6ea3b052c4a88ac'],
      [1000010000n, '76a914f94983b92eec64266a9dbcb6b3af6adb06824d0788ac'],
    ],
  },
  // DIP-2 special tx type 5 (coinbase) with a CbTx extra payload (block 1567774).
  coinbase: {
    txid: '81a97d0752795c62a2a58c43f2069ddb6673853c4b4ac6bc69824c1d70002b62',
    hex:
      '03000500010000000000000000000000000000000000000000000000000000000000000000ffffffff19031eec172f5032506f6f6c2d74444153482f6332706f6f6c2fffffffff05ba7f8c03000000001976a9140a7bf49abc7d07ade1826202b39a2b05a6d413ea88ac2ed5fd0300000000016a03aaa706000000001976a914c69a0bda7daaae481be8def95e5f347a1d00a4b488ac01000000000000001976a91420cb5c22b1e4d5947e5c112c7696b51ad9af3c6188ac00000000000000002a6a280000000000000000000000000000000000000000000000000000000000000000000000000000000000000000af03001eec170025fb1b7b552062944faf4459f21bb5d9eae59060a60823a5107dc1f22a2cd697a28c57ca5918652f350ef89af91b68384189bbb6839628919bd5212b414f28fe008c6c5d58ea0e82d65a52249825338d416982dfdccea329e4078ec5681bd0dd5cc24fd7febeaf8d399778e2853d045cdc03aede10abb4c46b5e1b4dd19e818d41a9a367f856e57e410dcb3b3daf8420d50efc559a11022dd56cd7d3d014d7233d6538a070d9210000',
    version: 3,
    txType: 5,
    outputs: [
      [59539386n, '76a9140a7bf49abc7d07ade1826202b39a2b05a6d413ea88ac'],
      [66966830n, '6a'],
      [111651331n, '76a914c69a0bda7daaae481be8def95e5f347a1d00a4b488ac'],
      [1n, '76a91420cb5c22b1e4d5947e5c112c7696b51ad9af3c6188ac'],
      [0n, '6a28' + '00'.repeat(40)],
    ],
  },
  // DIP-2 special tx type 9 (asset unlock): zero inputs plus extra payload (block 1534797).
  assetUnlock: {
    txid: '6baa9edfb8120b6d75f312e5af6fee73a0458c2c85d81580cdc010a2d28889f2',
    hex:
      '0300090000010bb9ed05000000001976a914478df76e5d44e3045e2f723d4a036cdd226b223488ac0000000091012105000000000000be0000004c6b1700cb5b139ecf4755d2733d98aa20ed23263141725c2fbfacbd148d32bab800000083b77136decef3ae7f533c307d9d276a667f08d8690f990c837f9e4cc263c31c495eda7cbc65df0bac3ba9dc302a41b91661d9d8fa8b45e04099f247d7214264f26b95198dd909dfac9fe92a0e1cb348e1b718cebf4dbd0038576305074782d1',
    version: 3,
    txType: 9,
    outputs: [[99465483n, '76a914478df76e5d44e3045e2f723d4a036cdd226b223488ac']],
  },
} as const;

/** Build a normal tx with this repo's serializer paying `value` to `publicKey`'s P2PKH at vout 1. */
function buildFundingTx(publicKey: Uint8Array, value: bigint): { raw: Uint8Array; txid: string } {
  const tx: AssetLockTransaction = {
    version: 2,
    txType: 0,
    vin: [{ prevout: { txid: new Uint8Array(32).fill(7), n: 3 }, scriptSig: new Uint8Array([0x51]), sequence: 0xffffffff }],
    vout: [
      { value: 12345n, scriptPubKey: new Uint8Array([0x6a]) },
      { value, scriptPubKey: createP2PKHScript(hash160(publicKey)) },
    ],
    lockTime: 0,
    extraPayload: new Uint8Array(0),
  };
  return { raw: serializeTransaction(tx), txid: calculateTxId(tx) };
}

function depositScriptHex(publicKey: Uint8Array): string {
  return bytesToHex(createP2PKHScript(hash160(publicKey)));
}

describe('parseTransaction / txidOfRawTransaction on real testnet transactions', () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    it(`${name}: bytes hash to the known txid and parse to the known outputs`, () => {
      const raw = hexToBytes(f.hex);
      expect(txidOfRawTransaction(raw)).toBe(f.txid);

      const parsed = parseTransaction(raw);
      expect(parsed.version).toBe(f.version);
      expect(parsed.txType).toBe(f.txType);
      expect(parsed.outputs.map((o) => [o.value, bytesToHex(o.scriptPubKey)])).toEqual(f.outputs);
    });
  }

  it('parses a self-built type 8 asset lock (special tx with payload)', () => {
    const { publicKey } = generateKeyPair();
    const utxo = { txid: 'ab'.repeat(32), vout: 0, satoshis: 500000, scriptPubKey: '', confirmations: 0 } as AuthenticatedUtxo;
    const tx = createAssetLockTransaction(utxo, publicKey, 1000n);
    const parsed = parseTransaction(serializeTransaction(tx));
    expect(parsed.txType).toBe(8);
    expect(parsed.outputs).toEqual(tx.vout);
  });

  it('parses 253+ inputs and outputs across the 0xfd compact-size boundary', () => {
    const count = 300;
    const tx: AssetLockTransaction = {
      version: 2,
      txType: 0,
      vin: Array.from({ length: count }, (_, i) => ({
        prevout: { txid: new Uint8Array(32).fill(i & 0xff), n: i },
        scriptSig: new Uint8Array([0x51]),
        sequence: 0xffffffff,
      })),
      vout: Array.from({ length: count }, (_, i) => ({
        value: BigInt(i + 1),
        scriptPubKey: new Uint8Array(i).fill(0x61), // up to 299 bytes: 0xfd-prefixed scripts too
      })),
      lockTime: 0,
      extraPayload: new Uint8Array(0),
    };
    const raw = serializeTransaction(tx);
    expect(raw[4]).toBe(0xfd); // input count uses the 3-byte form

    const parsed = parseTransaction(raw);
    expect(parsed.inputCount).toBe(count);
    expect(parsed.outputs).toEqual(tx.vout);
    expect(txidOfRawTransaction(raw)).toBe(calculateTxId(tx));
  });

  it('rejects truncated and trailing-byte input', () => {
    const raw = hexToBytes(FIXTURES.normal.hex);
    expect(() => parseTransaction(raw.slice(0, raw.length - 1))).toThrow(/truncated/);
    expect(() => parseTransaction(new Uint8Array([...raw, 0]))).toThrow(/trailing/);
  });

  it('rejects non-canonical compact sizes', () => {
    // version 2, input count 0 encoded as 0xfd 0x00 0x00
    expect(() => parseTransaction(new Uint8Array([2, 0, 0, 0, 0xfd, 0, 0]))).toThrow(/non-canonical/);
  });
});

describe('authenticateUtxo', () => {
  const { publicKey } = generateKeyPair();
  const value = 450000n;
  const { raw, txid } = buildFundingTx(publicKey, value);
  const reported: UTXO = {
    txid,
    vout: 1,
    satoshis: Number(value),
    scriptPubKey: depositScriptHex(publicKey),
    confirmations: 0,
  };

  it('returns the authenticated value and script on the happy path', () => {
    const result = authenticateUtxo({ ...reported, txid: txid.toUpperCase() }, raw, publicKey);
    expect(result).toEqual({ ...reported, txid });
  });

  it('rejects an understated Insight amount', () => {
    expect(() => authenticateUtxo({ ...reported, satoshis: 1000 }, raw, publicKey)).toThrow(
      /reported 1000 duffs .* says 450000/
    );
  });

  it('rejects an overstated Insight amount', () => {
    expect(() => authenticateUtxo({ ...reported, satoshis: 900000 }, raw, publicKey)).toThrow(
      UtxoAuthenticationError
    );
  });

  it('rejects bytes that do not hash to the txid', () => {
    const tampered = new Uint8Array(raw);
    tampered[tampered.length - 30] ^= 1;
    expect(() => authenticateUtxo(reported, tampered, publicKey)).toThrow(/does not match deposit txid/);
    // Real tx bytes under someone else's txid are also rejected.
    expect(() => authenticateUtxo(reported, hexToBytes(FIXTURES.normal.hex), publicKey)).toThrow(
      /does not match deposit txid/
    );
  });

  it('rejects an output index out of range', () => {
    expect(() => authenticateUtxo({ ...reported, vout: 2 }, raw, publicKey)).toThrow(/has no output 2/);
    expect(() => authenticateUtxo({ ...reported, vout: -1 }, raw, publicKey)).toThrow(/output index/);
  });

  it("rejects an output that is not the deposit key's P2PKH", () => {
    // vout 0 is an OP_RETURN in the self-built tx
    expect(() => authenticateUtxo({ ...reported, vout: 0, satoshis: 12345 }, raw, publicKey)).toThrow(
      /does not pay this bridge's deposit address/
    );
    // A real testnet output paying someone else
    const f = FIXTURES.normal;
    const foreign: UTXO = { txid: f.txid, vout: 0, satoshis: 1000010000, scriptPubKey: f.outputs[0][1], confirmations: 1 };
    expect(() => authenticateUtxo(foreign, hexToBytes(f.hex), publicKey)).toThrow(/deposit address/);
  });

  it('rejects an Insight script that disagrees with the raw output', () => {
    expect(() =>
      authenticateUtxo({ ...reported, scriptPubKey: '76a914' + '00'.repeat(20) + '88ac' }, raw, publicKey)
    ).toThrow(/different script/);
  });

  it('rejects a malformed txid', () => {
    expect(() => authenticateUtxo({ ...reported, txid: '../status' }, raw, publicKey)).toThrow(/malformed/);
  });
});

describe('InsightClient.getAuthenticatedUtxo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const { publicKey } = generateKeyPair();
  const { raw, txid } = buildFundingTx(publicKey, 450000n);
  const reported: UTXO = { txid, vout: 1, satoshis: 450000, scriptPubKey: depositScriptHex(publicKey), confirmations: 0 };

  function stubRawTx(body: unknown, status = 200) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('fetches /rawtx/{txid} and returns the authenticated UTXO', async () => {
    const fetchMock = stubRawTx({ rawtx: bytesToHex(raw) });
    const client = new InsightClient(TESTNET);
    await expect(client.getAuthenticatedUtxo(reported, publicKey)).resolves.toEqual(reported);
    expect(fetchMock).toHaveBeenCalledWith(
      `${TESTNET.insightApiUrl}/rawtx/${txid}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('refuses when Insight understates the UTXO', async () => {
    stubRawTx({ rawtx: bytesToHex(raw) });
    const client = new InsightClient(TESTNET);
    await expect(client.getAuthenticatedUtxo({ ...reported, satoshis: 2000 }, publicKey)).rejects.toThrow(
      UtxoAuthenticationError
    );
  });

  it('rejects a malformed rawtx body', async () => {
    stubRawTx({ rawtx: 'not hex' });
    const client = new InsightClient(TESTNET);
    await expect(client.getAuthenticatedUtxo(reported, publicKey)).rejects.toThrow(/malformed raw transaction/);
  });

  it('retries a 404 across the longer window, then explains it to the user', async () => {
    const fetchMock = stubRawTx('Not found', 404);
    const client = new InsightClient(TESTNET);
    await expect(
      client.getAuthenticatedUtxo(reported, publicKey, { baseDelayMs: 1, maxDelayMs: 1 })
    ).rejects.toThrow('The explorer has not indexed your deposit transaction yet. Wait a moment and use Check Again.');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('returns once a 404 clears', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Not found', { status: 404 }))
      .mockResolvedValue(new Response(JSON.stringify({ rawtx: bytesToHex(raw) })));
    vi.stubGlobal('fetch', fetchMock);
    const client = new InsightClient(TESTNET);
    await expect(
      client.getAuthenticatedUtxo(reported, publicKey, { baseDelayMs: 1, maxDelayMs: 1 })
    ).resolves.toEqual(reported);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable HTTP error', async () => {
    const fetchMock = stubRawTx('Bad request', 400);
    const client = new InsightClient(TESTNET);
    await expect(client.getAuthenticatedUtxo(reported, publicKey)).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an authentication failure', async () => {
    const fetchMock = stubRawTx({ rawtx: bytesToHex(raw) });
    const client = new InsightClient(TESTNET);
    // 1500000 contains "500", which isRetryableError would match if this were retried
    await expect(
      client.getAuthenticatedUtxo({ ...reported, satoshis: 1500000 }, publicKey)
    ).rejects.toThrow(UtxoAuthenticationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('asset lock fee bound', () => {
  const keyPair = generateKeyPair();
  // Stand-in for authenticateUtxo's output; the builder only accepts authenticated UTXOs.
  const utxo = {
    txid: 'cd'.repeat(32),
    vout: 1,
    satoshis: 450000,
    scriptPubKey: depositScriptHex(keyPair.publicKey),
    confirmations: 0,
  } as AuthenticatedUtxo;

  it('locks exactly the input minus the configured fee', () => {
    const tx = createAssetLockTransaction(utxo, keyPair.publicKey, 1000n);
    expect(tx.vout.map((o) => o.value)).toEqual([449000n]);
  });

  it('rejects a fee outside the bound', () => {
    expect(() => createAssetLockTransaction(utxo, keyPair.publicKey, 0n)).toThrow(/fee/);
    expect(() => createAssetLockTransaction(utxo, keyPair.publicKey, MAX_ASSET_LOCK_FEE + 1n)).toThrow(/fee/);
  });

  it('refuses to sign when the UTXO value would leave an oversized implicit fee', async () => {
    const tx = createAssetLockTransaction(utxo, keyPair.publicKey, 1000n);
    const inflated = { ...utxo, satoshis: utxo.satoshis + Number(MAX_ASSET_LOCK_FEE) };
    await expect(signTransaction(tx, [inflated], keyPair.privateKey, keyPair.publicKey)).rejects.toThrow(
      /Refusing to sign/
    );
  });

  it('refuses to sign with a UTXO that does not match the input', async () => {
    const tx = createAssetLockTransaction(utxo, keyPair.publicKey, 1000n);
    await expect(
      signTransaction(tx, [{ ...utxo, vout: 0 }], keyPair.privateKey, keyPair.publicKey)
    ).rejects.toThrow(/does not match/);
  });

  it('signs a well-formed asset lock', async () => {
    const tx = createAssetLockTransaction(utxo, keyPair.publicKey, 1000n);
    const signed = await signTransaction(tx, [utxo], keyPair.privateKey, keyPair.publicKey);
    expect(signed.vin[0].scriptSig.length).toBeGreaterThan(100);
  });
});

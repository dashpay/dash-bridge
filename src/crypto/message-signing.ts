/**
 * Dash signed messages (`signmessage` / `verifymessage` in Dash Core,
 * `Message` in dashcore-lib):
 *
 *   hash = SHA256(SHA256(varstr("DarkCoin Signed Message:\n") || varstr(utf8(message))))
 *   signature = base64(header || r || s), header = 27 + recoveryId (+ 4 when the
 *   key is compressed)
 *
 * Used by "Sign in with Dash" on both sides (bridge signs, the verifier
 * recovers), so keep it free of app dependencies.
 */
import * as secp256k1 from '@noble/secp256k1';
import { hash256 } from './hash.js';
import { concatBytes } from '../utils/hex.js';
import { base64ToBytes, bytesToBase64 } from '../utils/base64.js';

const MESSAGE_MAGIC = 'DarkCoin Signed Message:\n';
const COMPACT_SIGNATURE_LENGTH = 65;
/** Header byte range for a compressed public key: 27 + 4 + recoveryId (0-3). */
const COMPRESSED_HEADER_MIN = 31;
const COMPRESSED_HEADER_MAX = 34;

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

function varstr(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  return concatBytes(varint(bytes.length), bytes);
}

/** The 32-byte digest a Dash message signature commits to. */
export function dashMessageHash(message: string): Uint8Array {
  return hash256(concatBytes(varstr(MESSAGE_MAGIC), varstr(message)));
}

/** Strict base64 (padded, standard alphabet), or null. */
function fromBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    return base64ToBytes(value);
  } catch {
    return null;
  }
}

/** Sign `message` with a private key; returns the base64 compact signature (compressed key). */
export async function signDashMessage(message: string, privateKey: Uint8Array): Promise<string> {
  const sig = await secp256k1.signAsync(dashMessageHash(message), privateKey, { lowS: true });
  return bytesToBase64(concatBytes(Uint8Array.of(COMPRESSED_HEADER_MIN + sig.recovery), sig.toCompactRawBytes()));
}

/**
 * Recover the compressed public key that signed `message`, or null if the
 * signature is malformed, not for a compressed key, or invalid.
 */
export function recoverDashMessageSigner(message: string, signatureBase64: string): Uint8Array | null {
  const sig = fromBase64(signatureBase64);
  if (!sig || sig.length !== COMPACT_SIGNATURE_LENGTH) return null;
  const header = sig[0];
  if (header < COMPRESSED_HEADER_MIN || header > COMPRESSED_HEADER_MAX) return null;
  try {
    const point = secp256k1.Signature.fromCompact(sig.slice(1))
      .addRecoveryBit(header - COMPRESSED_HEADER_MIN)
      .recoverPublicKey(dashMessageHash(message));
    return point.toRawBytes(true);
  } catch {
    return null;
  }
}

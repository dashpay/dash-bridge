/* eslint-disable @typescript-eslint/no-explicit-any */

// DAPI's subscribeToMasternodeList stream returns CBOR-encoded SML diffs,
// not Core's raw wire-format SimplifiedMNListDiff. The DAPI server CBOR-
// encodes Core's view of the diff (with field names like nVersion,
// baseBlockHash, mnList, newQuorums, quorumsCLSigs) before placing the
// bytes in the masternode_list_diff field of MasternodeListResponse.
// dapi-client itself does `cbor.decodeFirstSync(bytes)` and then hands
// the resulting object — not the bytes — to dashcore-lib's
// SimplifiedMNListDiff(arg) constructor, which has both Buffer and Object
// code paths.
//
// The wire-format path through dashcore-lib v0.22 fails on current Core
// (23.1.x) cbTx payloads with "Unknown special transaction type" because
// the coinbase special-tx layout extended past what that parser knows.
// CBOR sidesteps that entirely: DAPI hands us a parsed object and we no
// longer touch the cbTx body.
//
// decodeSmlDiff tries CBOR first (the documented and observed DAPI shape)
// and falls back to dashcore-lib's wire-format parser for callers that
// pass bytes from a direct Core RPC `protx diff` (which is still wire
// format). Both paths normalise into the SmlDiff shape below.

import cbor from 'cbor';
import dashcoreLib from '@dashevo/dashcore-lib';

export interface SmlMnEntry {
  proRegTxHash: string;
  confirmedHash: string;
  service?: string;
  pubKeyOperator: string;
  votingAddress?: string;
  isValid: boolean;
  nVersion?: number;
  nType?: number;
  platformHTTPPort?: number;
  platformNodeID?: string;
}

export interface SmlQuorumEntry {
  version: number;
  llmqType: number;
  quorumHash: string;
  quorumIndex?: number;
  signersCount: number;
  signers: string;
  validMembersCount: number;
  validMembers: string;
  quorumPublicKey: string;
  quorumVvecHash: string;
  quorumSig: string;
  membersSig: string;
}

export interface SmlDeletedQuorum {
  llmqType: number;
  quorumHash: string;
}

// Each entry maps a 96-byte BLS chain-lock sig (hex) to the quorum indices
// it covers, e.g. { "<sigHex>": [0, 4, 5, 6] }.
export type SmlQuorumsCLSigs = Array<Record<string, number[]>>;

export interface SmlDiff {
  nVersion: number;
  baseBlockHash: string;
  blockHash: string;
  deletedMNs: string[];
  mnList: SmlMnEntry[];
  deletedQuorums: SmlDeletedQuorum[];
  newQuorums: SmlQuorumEntry[];
  quorumsCLSigs: SmlQuorumsCLSigs;
  merkleRootMNList?: string;
  merkleRootQuorums?: string;
}

function toHex(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Buffer.isBuffer(value)) return (value as Buffer).toString('hex');
  if (Array.isArray(value)) return Buffer.from(value as number[]).toString('hex');
  return String(value);
}

function normalizeMnEntry(entry: any): SmlMnEntry {
  return {
    proRegTxHash: toHex(entry.proRegTxHash),
    confirmedHash: toHex(entry.confirmedHash),
    service: entry.service ?? (Array.isArray(entry.addresses) ? entry.addresses.join(',') : undefined),
    pubKeyOperator: toHex(entry.pubKeyOperator),
    votingAddress: entry.votingAddress,
    isValid: Boolean(entry.isValid),
    nVersion: entry.nVersion,
    nType: entry.nType,
    platformHTTPPort: entry.platformHTTPPort,
    platformNodeID: entry.platformNodeID ? toHex(entry.platformNodeID) : undefined,
  };
}

function normalizeQuorum(q: any): SmlQuorumEntry {
  return {
    version: q.version,
    llmqType: q.llmqType,
    quorumHash: toHex(q.quorumHash),
    quorumIndex: q.quorumIndex,
    signersCount: q.signersCount,
    signers: toHex(q.signers),
    validMembersCount: q.validMembersCount,
    validMembers: toHex(q.validMembers),
    quorumPublicKey: toHex(q.quorumPublicKey),
    quorumVvecHash: toHex(q.quorumVvecHash),
    quorumSig: toHex(q.quorumSig),
    membersSig: toHex(q.membersSig),
  };
}

function normalizeDeletedQuorum(d: any): SmlDeletedQuorum {
  return { llmqType: d.llmqType, quorumHash: toHex(d.quorumHash) };
}

function normalizeCLSigs(entries: any): SmlQuorumsCLSigs {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry: any) => {
    const out: Record<string, number[]> = {};
    for (const [sig, indices] of Object.entries(entry as Record<string, unknown>)) {
      out[toHex(sig)] = Array.isArray(indices) ? (indices as number[]) : [];
    }
    return out;
  });
}

function normalizeDiff(obj: any): SmlDiff {
  return {
    nVersion: obj.nVersion,
    baseBlockHash: toHex(obj.baseBlockHash),
    blockHash: toHex(obj.blockHash),
    deletedMNs: Array.isArray(obj.deletedMNs) ? obj.deletedMNs.map(toHex) : [],
    mnList: Array.isArray(obj.mnList) ? obj.mnList.map(normalizeMnEntry) : [],
    deletedQuorums: Array.isArray(obj.deletedQuorums)
      ? obj.deletedQuorums.map(normalizeDeletedQuorum)
      : [],
    newQuorums: Array.isArray(obj.newQuorums) ? obj.newQuorums.map(normalizeQuorum) : [],
    quorumsCLSigs: normalizeCLSigs(obj.quorumsCLSigs),
    merkleRootMNList: obj.merkleRootMNList ? toHex(obj.merkleRootMNList) : undefined,
    merkleRootQuorums: obj.merkleRootQuorums ? toHex(obj.merkleRootQuorums) : undefined,
  };
}

/**
 * Decode a SimplifiedMNListDiff blob from DAPI.
 *
 * Tries CBOR (what DAPI 3.x actually emits) first, then falls back to
 * dashcore-lib's Core wire-format parser so callers can also feed it raw
 * bytes from a direct `protx diff` RPC. Returns a normalised object with
 * hex-encoded byte fields.
 */
export function decodeSmlDiff(bytes: Uint8Array): SmlDiff {
  const buf = Buffer.from(bytes);

  let cborErr: unknown = 'decoded CBOR object is missing nVersion or mnList';
  try {
    const obj = cbor.decodeFirstSync(buf);
    if (obj && typeof obj === 'object' && 'nVersion' in (obj as any) && 'mnList' in (obj as any)) {
      return normalizeDiff(obj);
    }
  } catch (err) {
    cborErr = err;
  }

  // Wire-format fallback for callers that feed bytes directly from Core's
  // `protx diff` RPC. DAPI itself only emits CBOR, so this path is unused
  // by the bridge runtime. Note: dashcore-lib's fromBuffer doesn't carry
  // quorumsCLSigs (the wire format never had them in v0.22), so CL sigs
  // come back as [] on this branch.
  try {
    const SimplifiedMNListDiff = (dashcoreLib as any).SimplifiedMNListDiff;
    const diff = new SimplifiedMNListDiff(buf);
    return normalizeDiff(diff);
  } catch (wireErr) {
    const cborMsg = cborErr instanceof Error ? cborErr.message : String(cborErr);
    const wireMsg = wireErr instanceof Error ? wireErr.message : String(wireErr);
    throw new Error(`decodeSmlDiff: not CBOR (${cborMsg}) and not wire-format (${wireMsg})`);
  }
}

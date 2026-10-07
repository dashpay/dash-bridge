export {
  serCompactSize,
  serString,
  serUint32,
  serInt32,
  serInt64,
  serByte,
} from './serialize.js';

export {
  type COutPoint,
  type CTxIn,
  type CTxOut,
  type CAssetLockPayload,
  serializeOutPoint,
  serializeTxIn,
  serializeTxOut,
  serializeAssetLockPayload,
  createP2PKHScript,
  createOpReturnScript,
} from './structures.js';

export {
  type AssetLockTransaction,
  serializeTransaction,
  calculateTxId,
  createAssetLockTransaction,
  cloneTransaction,
  implicitFee,
  MAX_ASSET_LOCK_FEE,
} from './builder.js';

export {
  type ParsedTransaction,
  parseTransaction,
  txidOfRawTransaction,
} from './parse.js';

export {
  UtxoAuthenticationError,
  authenticateUtxo,
} from './utxo-auth.js';

export {
  signatureHash,
  getScriptCodeFromUtxo,
  SIGHASH_ALL,
} from './sighash.js';

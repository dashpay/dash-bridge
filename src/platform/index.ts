export {
  KeyType as KeyTypeNumeric,
  KeyPurpose as KeyPurposeNumeric,
  SecurityLevel as SecurityLevelNumeric,
  KeyTypeString,
  KeyPurposeString,
  SecurityLevelString,
  createPublicKeyInfo,
  publicKeyToBase64,
  registerIdentity,
  registerIdentityResilient,
  topUpIdentity,
  updateIdentity,
  sendToPlatformAddress,
} from './identity.js';

export type { AddKeyConfig } from './identity.js';

export {
  withdrawCredits,
  fetchLatestWithdrawalStatus,
  WithdrawalStatus,
  WITHDRAWALS_CONTRACT_ID,
} from './withdrawal.js';

export type { WithdrawResult, WithdrawalStatusRecord } from './withdrawal.js';

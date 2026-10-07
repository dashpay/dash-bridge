import type { EmbedKind, EmbedRequestType } from './embed/protocol.js';
import type { NearIntentsQuote, NearIntentsToken, NearSwapStatus } from './api/near-intents.js';

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export type E2EMockWindow = Window & { __e2eMockAdvance?: () => void };

export interface UTXO {
  txid: string;
  vout: number;
  satoshis: number;
  scriptPubKey: string;
  confirmations: number;
}

declare const authenticatedUtxoBrand: unique symbol;

/**
 * A UTXO whose value and script were verified against the raw transaction
 * that created it (see `authenticateUtxo`). Only these can fund an asset lock,
 * so skipping authentication is a compile error.
 */
export type AuthenticatedUtxo = UTXO & { readonly [authenticatedUtxoBrand]: true };

export interface TxInfo {
  txid: string;
  confirmations: number;
  txlock?: boolean;
  /** Block height the tx is confirmed in. Undefined while in mempool. */
  blockheight?: number;
}

export interface PublicKeyInfo {
  id: number;
  type: number;
  purpose: number;
  securityLevel: number;
  data: string;
  readOnly: boolean;
}

/**
 * Key types supported by Dash Platform
 */
export type KeyType = 'ECDSA_SECP256K1' | 'ECDSA_HASH160';

/**
 * Key purposes supported by Dash Platform
 */
export type KeyPurpose = 'AUTHENTICATION' | 'ENCRYPTION' | 'TRANSFER' | 'VOTING' | 'OWNER';

/**
 * Security levels supported by Dash Platform
 */
export type SecurityLevel = 'MASTER' | 'CRITICAL' | 'HIGH' | 'MEDIUM';

/**
 * Configuration for a single identity key
 */
export interface IdentityKeyConfig {
  id: number;
  name: string;
  keyType: KeyType;
  purpose: KeyPurpose;
  securityLevel: SecurityLevel;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  privateKeyHex: string;
  privateKeyWif: string;
  publicKeyHex: string;
  /** Base64 data for SDK - full pubkey for SECP256K1, hash160 for ECDSA_HASH160 */
  dataBase64: string;
  /** HD derivation path (e.g., "m/9'/5'/5'/0'/0'/0'/0'") */
  derivationPath?: string;
}

/**
 * Bridge operation mode
 */
export type BridgeMode = 'create' | 'topup' | 'send_to_address' | 'dpns' | 'manage' | 'contract' | 'withdraw' | 'login';

/**
 * DPNS identity source for standalone mode
 */
export type DpnsIdentitySource = 'new' | 'existing';

/**
 * Status of a DPNS username entry during the flow
 */
export type DpnsUsernameStatus = 'pending' | 'checking' | 'available' | 'taken' | 'invalid';

/**
 * DPNS username entry with validation/availability status
 */
export interface DpnsUsernameEntry {
  /** Raw user input (e.g., "alice") */
  label: string;
  /** Homograph-safe version (e.g., "a11ce") */
  normalizedLabel: string;
  /** Passes DPNS validation rules */
  isValid: boolean;
  /** If invalid, why */
  validationError?: string;
  /** null = unchecked, true/false = checked */
  isAvailable?: boolean;
  /** 3-19 chars, only [a-z, 0, 1, -] after normalization */
  isContested?: boolean;
  /** Current status in the flow */
  status: DpnsUsernameStatus;
}

/**
 * DPNS registration result for a single name
 */
export interface DpnsRegistrationResult {
  label: string;
  success: boolean;
  error?: string;
  /** If contested, voting required */
  isContested: boolean;
}

/**
 * Public key info fetched from an identity on the network
 */
export interface IdentityPublicKeyInfo {
  id: number;
  type: number;
  purpose: number;
  securityLevel: number;
  data: Uint8Array;
  /** Whether the key is disabled */
  isDisabled?: boolean;
  /** Whether the key is restricted to a single contract (contractBounds set) */
  isContractBound?: boolean;
  /** The SDK reported a key type, purpose or security level we don't know */
  unrecognized?: boolean;
}

/**
 * How the user supplied credentials for a username transfer.
 * 'seed' auto-discovers the identity; 'key' takes an identity ID + WIF.
 */
export type UsernameTransferCredentialSource = 'seed' | 'key';

/**
 * A username an identity owns, paired with the DPNS document that backs it.
 * The document id is carried so the transfer never has to resolve a display
 * name back to a document.
 */
export interface OwnedUsername {
  username: string;
  documentId: string;
  ownerId: string;
}

/**
 * Outcome of a username transfer attempt.
 */
export interface UsernameTransferOutcome {
  success: boolean;
  error?: string;
  /** Whether the domain document's owner was confirmed to be the recipient */
  verifiedOwner?: boolean;
  /** Whether `records.identity` was rewritten, so the name resolves to the recipient */
  recordsUpdated?: boolean;
  /**
   * Set on failure when the domain document could not be read back, so we
   * genuinely do not know whether the transfer landed. Distinct from a
   * confirmed failure, because a transfer that landed must not be retried
   * blindly.
   */
  unconfirmed?: boolean;
}

/**
 * Configuration for a new key to add during identity update
 */
export interface ManageNewKeyConfig {
  /** Temporary ID for UI tracking (not the final on-chain ID) */
  tempId: string;
  keyType: KeyType;
  purpose: KeyPurpose;
  securityLevel: SecurityLevel;
  /** 'generate' = create new random key, 'import' = user provides public key */
  source: 'generate' | 'import';
  /** For generated keys: the generated key data */
  generatedKey?: {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    privateKeyHex: string;
    privateKeyWif: string;
    publicKeyHex: string;
  };
  /** For imported keys: base64-encoded public key data */
  importedPublicKeyBase64?: string;
}

export type BridgeStep =
  | 'init'
  | 'mobile_app_recommended' // Mainnet: recommend the DashPay app before creating an identity here
  | 'configure_keys'
  | 'enter_identity'      // Top-up: user enters identity ID
  | 'generating_keys'
  | 'awaiting_deposit'
  | 'detecting_deposit'
  | 'building_transaction'
  | 'signing_transaction'
  | 'broadcasting'
  | 'waiting_islock'
  | 'waiting_chainlock'      // Fallback: waiting for asset lock tx confirmation + chain lock
  | 'registering_identity'
  | 'topping_up'          // Top-up: calling sdk.identities.topUp()
  | 'enter_recipient_address' // Send to address: user enters recipient bech32m address
  | 'sending_to_address'      // Send to address: calling sdk.addresses.fundFromAssetLock()
  | 'complete'
  | 'error'
  // DPNS username registration steps
  | 'dpns_choose_identity'    // Choose: create new or use existing
  | 'dpns_enter_identity'     // Enter existing identity ID + private key
  | 'dpns_enter_usernames'    // Enter username(s)
  | 'dpns_checking'           // Check availability
  | 'dpns_review'             // Review with contested warning
  | 'dpns_registering'        // Registration in progress
  | 'dpns_complete'           // Done
  // Identity Management steps
  | 'manage_choose_action'    // Choose: manage keys or transfer a username
  | 'manage_enter_identity'   // Enter identity ID + private key WIF
  | 'manage_view_keys'        // Display current keys, configure changes
  | 'manage_updating'         // Update transition in progress
  | 'manage_complete'         // Update complete
  // Username transfer steps
  | 'xfer_credentials'        // Enter seed phrase (auto-discovers identity) or identity ID + WIF
  | 'xfer_select_username'    // Pick an owned username + destination identity ID
  | 'xfer_review'             // Confirm the irreversible transfer
  | 'xfer_transferring'       // Document transfer transition in progress
  | 'xfer_complete'           // Transfer complete
  // Contract registration steps
  | 'contract_choose_identity'  // Choose: create new or use existing
  | 'contract_enter_identity'   // Enter existing identity ID + private key
  | 'contract_enter_contract'   // Paste contract JSON, see fee estimate
  | 'contract_review'           // Review contract + fees before publishing
  | 'contract_registering'      // Publishing contract on platform
  | 'contract_complete'         // Contract registered
  // Withdraw (asset unlock) steps
  | 'withdraw_enter_identity'   // Enter identity ID, fetch keys + balance
  | 'withdraw_configure'        // Enter TRANSFER key WIF, destination address, amount
  | 'withdraw_submitting'       // Credit withdrawal transition in flight
  | 'withdraw_tracking'         // Polling withdrawal document status
  | 'withdraw_complete'         // Withdrawal done (or failed)
  // Sign in with Dash (embed request=login)
  | 'login_input'               // Enter identity ID + AUTHENTICATION key WIF
  | 'login_verifying'           // Fetching the identity's keys, checking the WIF
  | 'login_review'              // Approve: which app, identity and key
  | 'login_complete'            // Signed; result delivered to the app
  | 'login_cancelled';          // User cancelled; terminal

/**
 * Status of network retry attempts
 */
export interface RetryStatus {
  /** Whether a retry is currently in progress */
  isRetrying: boolean;
  /** Current retry attempt number (1-indexed) */
  attempt: number;
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Error message from the last failed attempt */
  lastError?: string;
}

/**
 * Asset lock proof data, tagged by variant so the platform layer can build
 * the corresponding typed SDK proof. Instant proofs ship the islock + tx
 * bytes; chain proofs ship only the outpoint plus the chain-locked height
 * that buries the confirming block.
 */
export type AssetLockProofData =
  | {
      type: 'instant';
      transactionBytes: Uint8Array;
      instantLockBytes: Uint8Array;
      outputIndex: number;
    }
  | {
      type: 'chain';
      coreChainLockedHeight: number;
      txid: string;
      vout: number;
    };

/**
 * Overall network-health verdict shown in the header.
 * - `healthy`: Core and Platform are both advancing in lock-step.
 * - `degraded`: a mild lag (chain-lock or Platform block age) worth surfacing.
 * - `stalled`: Platform consensus is stuck while Core keeps moving (or a side
 *   is unreachable enough to be unusable).
 * - `unknown`: we couldn't gather enough signal to judge.
 */
export type NetworkHealth = 'healthy' | 'degraded' | 'stalled' | 'unknown';

/**
 * Snapshot of network health derived from Insight (Core) and DAPI/Platform
 * status. Lets the UI warn when Platform consensus stalls while Core keeps
 * producing blocks — the failure mode where the app sees deposits confirm but
 * identity registration hangs.
 */
export interface NetworkStatus {
  health: NetworkHealth;
  /** Core block height from Insight (`/status?q=getInfo` → `info.blocks`). */
  coreHeight?: number;
  /** Platform's view of the chain-locked Core height (getStatus chain.coreChainLockedHeight). */
  coreChainLockedHeight?: number;
  /** Tenderdash/Platform latest block height. */
  platformBlockHeight?: number;
  /** Tenderdash latest block time, ms since epoch. */
  platformBlockTimeMs?: number;
  /** coreHeight − coreChainLockedHeight, when both are known. */
  chainLockLag?: number;
  /** now − platformBlockTimeMs, when known. */
  platformBlockAgeMs?: number;
  /** Human-readable explanations for a degraded/stalled verdict. */
  reasons: string[];
  /** When this snapshot was taken, ms since epoch. */
  checkedAtMs: number;
}

/** Embed mode: who asked the bridge to run (shown in the UI banner). */
export interface EmbedDisplay {
  kind: EmbedKind;
  /** Verified-by-delivery origin that receives the result. */
  origin: string;
  /** Self-declared app name; display only. */
  appName?: string;
  /** What the app asked for (drives the banner wording). */
  request: EmbedRequestType;
  /** `login`: app-supplied statement, sanitized; part of the signed message. */
  statement?: string;
}

/** Login: the identity key the user's WIF matched (no private material). */
export interface LoginKeyInfo {
  keyId: number;
  securityLevel: number;
  /** 0 = ECDSA_SECP256K1, 2 = ECDSA_HASH160 */
  type: number;
}

/** Embed mode: message shown instead of the app when it must not run. */
export interface EmbedNotice {
  title: string;
  message: string;
  /** Offer a link that opens the standalone bridge in a new tab. */
  openHref?: string;
}

/** A NEAR Intents swap whose deposit address has been handed to the user. */
export interface NearIntentsSwap {
  /** Where the user sends the source asset (origin chain). */
  depositAddress: string;
  depositMemo?: string;
  /** Bridge deposit address the DASH is delivered to. */
  recipient: string;
  /** User's origin-chain address that receives refunds. */
  refundTo: string;
  originAssetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  /** Amount to send, in the source asset's smallest units. */
  amountIn: string;
  /** DASH delivered, in duffs. */
  amountOut: string;
  /** ISO time after which an unfunded swap is refunded. */
  deadline: string;
  correlationId?: string;
  status: NearSwapStatus;
  /** Last status poll failed (informational; polling continues). */
  statusError?: string;
}

/** "Pay with other crypto" panel on the mainnet deposit screen. */
export interface NearIntentsState {
  open: boolean;
  tokens?: NearIntentsToken[];
  /** Search text narrowing the asset list. */
  assetFilter: string;
  originAssetId?: string;
  /** DASH to deliver, as typed. */
  amountInput: string;
  refundAddress: string;
  /** Request in flight: loading tokens, pricing a quote, or opening a swap. */
  busy?: 'tokens' | 'quote' | 'confirm';
  /** Dry quote awaiting the user's confirmation. */
  quote?: NearIntentsQuote;
  swap?: NearIntentsSwap;
  error?: string;
}

export interface BridgeState {
  step: BridgeStep;
  network: string;
  /** Set when a third-party app opened the bridge (see src/embed). */
  embed?: EmbedDisplay;
  /** Bridge operation mode */
  mode: BridgeMode;
  /** Current network retry status (for displaying retry indicator) */
  retryStatus?: RetryStatus;
  /** Latest network-health snapshot for the header indicator */
  networkStatus?: NetworkStatus;
  /** Mainnet: user acknowledged the browser is less secure than the DashPay app */
  mobileAppRiskAcknowledged?: boolean;
  /** BIP39 mnemonic (12 words) for HD key derivation */
  mnemonic?: string;
  assetLockKeyPair?: KeyPair;
  /** Configurable identity keys */
  identityKeys: IdentityKeyConfig[];
  depositAddress?: string;
  detectedUtxo?: UTXO;
  depositAmount?: bigint;
  signedTxHex?: string;
  /** Raw bytes of the signed asset lock tx — kept so the chainlock fallback can re-build proofs without re-parsing hex. */
  signedTxBytes?: Uint8Array;
  txid?: string;
  instantLockBytes?: Uint8Array;
  assetLockProof?: AssetLockProofData;
  /** Block height of the asset lock tx, observed via Insight. Populated while in waiting_chainlock. */
  assetLockTxBlockHeight?: number;
  /** Last-seen chain-locked tip height from Platform (sdk.system.status()). Populated while in waiting_chainlock. */
  coreChainLockedHeight?: number;
  /** When true, the error screen offers a "Use chainlock proof instead" recovery button. */
  chainlockFallbackAvailable?: boolean;
  identityId?: string;
  /**
   * Identity ID derived from the asset lock when registration was submitted
   * but not confirmed. Only for the error-screen key backup and diagnostics;
   * NOT a completed identity (that is `identityId`).
   */
  unconfirmedIdentityId?: string;
  error?: Error;
  /** Error code for user-facing display (e.g., "ERR-1006") */
  errorCode?: string;
  /** The step that was active when the error occurred */
  errorStep?: BridgeStep;
  /** True when deposit detection timed out and needs manual recheck */
  depositTimedOut?: boolean;
  /** Current detected deposit amount (may be below minimum) */
  detectedDepositAmount?: number;
  /** Why a detected deposit could not be verified (shown with the recheck button) */
  depositVerificationError?: string;
  /** Target identity ID for top-up (user-provided) */
  targetIdentityId?: string;
  /** Whether asset lock key is a one-time random key (for top-up/send_to_address) vs HD-derived */
  isOneTimeKey?: boolean;

  /** Send to address: recipient bech32m platform address */
  recipientPlatformAddress?: string;

  // DPNS username registration fields
  /** DPNS: usernames to register */
  dpnsUsernames?: DpnsUsernameEntry[];
  /** DPNS: registration results */
  dpnsResults?: DpnsRegistrationResult[];
  /** DPNS: whether user came from identity creation complete screen */
  dpnsFromIdentityCreation?: boolean;
  /** DPNS: identity source for standalone mode */
  dpnsIdentitySource?: DpnsIdentitySource;
  /** DPNS: private key WIF for existing identity (user-provided) */
  dpnsPrivateKeyWif?: string;
  /** DPNS: public key ID to use for registration */
  dpnsPublicKeyId?: number;
  /** DPNS: all contested names warning acknowledged */
  dpnsContestedWarningAcknowledged?: boolean;
  /** DPNS: current registration progress (index) */
  dpnsRegistrationProgress?: number;
  /** DPNS: fetched identity public keys */
  dpnsIdentityKeys?: IdentityPublicKeyInfo[];
  /** DPNS: whether identity is being fetched */
  dpnsIdentityFetching?: boolean;
  /** DPNS: error message if identity fetch failed */
  dpnsIdentityFetchError?: string;
  /** DPNS: validated key ID (auto-detected from private key) */
  dpnsValidatedKeyId?: number;
  /** DPNS: key validation error message */
  dpnsKeyValidationError?: string;

  // Identity Management fields
  /** Manage: keys to add during update operation */
  manageKeysToAdd?: ManageNewKeyConfig[];
  /** Manage: key IDs to disable during update operation */
  manageKeyIdsToDisable?: number[];
  /** Manage: private key WIF for signing update transition */
  managePrivateKeyWif?: string;
  /** Manage: validated signing key info */
  manageSigningKeyInfo?: { keyId: number; securityLevel: number };
  /** Manage: identity fetching state */
  manageIdentityFetching?: boolean;
  /** Manage: identity fetch error */
  manageIdentityFetchError?: string;
  /** Manage: fetched identity keys */
  manageIdentityKeys?: IdentityPublicKeyInfo[];
  /** Manage: update result */
  manageUpdateResult?: { success: boolean; error?: string };
  /** Manage: key validation error message */
  manageKeyValidationError?: string;
  /**
   * Whether the current flow was entered from the Manage Identity menu rather
   * than from the init screen or a deep link. Drives where Back returns to,
   * since top-up and withdraw are reachable both ways.
   */
  fromManageMenu?: boolean;

  // Username transfer fields
  /** Transfer: how the user supplied credentials */
  xferCredentialSource?: UsernameTransferCredentialSource;
  /** Transfer: raw seed phrase input (kept so the field survives re-render) */
  xferMnemonic?: string;
  /**
   * Transfer: progress message shown while discovering or loading usernames.
   * Its presence *is* the "discovery in progress" flag — a separate boolean
   * would allow a discovering-without-a-message state that means nothing.
   */
  xferDiscoveryStatus?: string;
  /** Transfer: credential entry error message */
  xferCredentialError?: string;
  /** Transfer: WIF for the key that will sign the transfer */
  xferPrivateKeyWif?: string;
  /** Transfer: validated signing key */
  xferSigningKeyInfo?: { keyId: number; securityLevel: number };
  /** Transfer: usernames owned by the source identity */
  xferOwnedUsernames?: OwnedUsername[];
  /** Transfer: other identities the seed controls, if it found more than one */
  xferOtherIdentities?: string[];
  /** Transfer: the username selected for transfer */
  xferSelectedUsername?: string;
  /** Transfer: destination identity ID */
  xferRecipientId?: string;
  /** Transfer: recipient validation error message */
  xferRecipientError?: string;
  /** Transfer: whether the recipient identity was confirmed to exist */
  xferRecipientVerified?: boolean;
  /** Transfer: recipient existence check in progress */
  xferRecipientChecking?: boolean;
  /** Transfer: network protocol version (transfers need >= 13) */
  xferProtocolVersion?: number;
  /** Transfer: whether the user acknowledged that transfers are irreversible */
  xferConfirmationAcknowledged?: boolean;
  /** Transfer: result of the transfer attempt */
  xferResult?: UsernameTransferOutcome;

  // Contract registration fields
  /** Contract: identity source (new or existing) */
  contractIdentitySource?: 'new' | 'existing';
  /** Contract: raw JSON string from user input */
  contractJson?: string;
  /** Contract: parsed contract structure (from fee estimator) */
  contractParsed?: { documentTypes: { name: string; indexes: { name: string; unique: boolean; contested: boolean }[] }[]; tokens: { position: string; hasPerpetualDistribution: boolean; hasPreProgrammedDistribution: boolean }[]; keywords: string[] };
  /** Contract: fee estimate (from fee estimator) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contractEstimate?: { totalCredits: number; totalDash: number; lineItems: { label: string; description: string; count: number; unitCostCredits: number; totalCostCredits: number }[]; constants: any };
  /** Contract: parse error message */
  contractParseError?: string;
  /** Contract: whether user came from identity creation */
  contractFromIdentityCreation?: boolean;
  /** Contract: private key WIF for existing identity */
  contractPrivateKeyWif?: string;
  /** Contract: public key ID for signing */
  contractPublicKeyId?: number;
  /** Contract: fetched identity keys */
  contractIdentityKeys?: IdentityPublicKeyInfo[];
  /** Contract: whether identity is being fetched */
  contractIdentityFetching?: boolean;
  /** Contract: identity fetch error */
  contractIdentityFetchError?: string;
  /** Contract: whether key is validated */
  contractKeyValidated?: boolean;
  /** Contract: key validation error */
  contractKeyValidationError?: string;
  /** Contract: published contract ID */
  contractRegisteredId?: string;
  /** Contract: identity credit balance (for existing identity) */
  contractIdentityBalance?: number;
  /** Minimum deposit amount in satoshis (overrides default 300,000 for contract mode) */
  minimumDeposit?: number;

  // Withdraw (asset unlock) fields
  /** Withdraw: whether identity is being fetched */
  withdrawIdentityFetching?: boolean;
  /** Withdraw: identity fetch error */
  withdrawIdentityFetchError?: string;
  /** Withdraw: fetched identity keys */
  withdrawIdentityKeys?: IdentityPublicKeyInfo[];
  /** Withdraw: identity credit balance in credits */
  withdrawBalance?: bigint;
  /** Withdraw: private key WIF for signing (must match a TRANSFER key) */
  withdrawPrivateKeyWif?: string;
  /** Withdraw: validated signing key info */
  withdrawSigningKeyInfo?: { keyId: number; purpose: number; securityLevel: number };
  /** Withdraw: key validation error message */
  withdrawKeyValidationError?: string;
  /** Withdraw: destination Dash Core address as typed (valid when withdrawAddressError is unset) */
  withdrawToAddress?: string;
  /** Withdraw: destination address validation error */
  withdrawAddressError?: string;
  /** Withdraw: validated amount to withdraw, in credits */
  withdrawAmountCredits?: bigint;
  /** Withdraw: raw DASH amount input (preserved across re-renders) */
  withdrawAmountInput?: string;
  /** Withdraw: amount validation error */
  withdrawAmountError?: string;
  /** Withdraw: submission result */
  withdrawResult?: { success: boolean; remainingBalance?: bigint; error?: string };
  /** Withdraw: latest withdrawal document status (0 QUEUED, 1 POOLED, 2 BROADCASTED, 3 COMPLETE, 4 EXPIRED) */
  withdrawStatus?: number;
  /** Withdraw: status polling problem / timeout explanation (informational, not a failure) */
  withdrawStatusError?: string;
  /**
   * Withdraw: set when the submission errored AND the follow-up lookups could
   * not tell whether the withdrawal landed. Retrying is unsafe in this state
   * (it could withdraw twice); the UI offers "Check Again" instead.
   * `sinceMs` is the lower bound used to match the withdrawal document.
   */
  withdrawOutcomeUnknown?: { sinceMs: number; checking: boolean };

  // Sign in with Dash fields
  /** Login: identity ID as typed */
  loginIdentityId?: string;
  /** Login: WIF as typed. Cleared as soon as the login is signed or cancelled. */
  loginPrivateKeyWif?: string;
  /** Login: show the WIF in clear text */
  loginShowWif?: boolean;
  /** Login: why the identity/key can't be used */
  loginError?: string;
  /** Login: the key that will sign (set on the review step) */
  loginKey?: LoginKeyInfo;

  // Faucet request state
  /** Current status of faucet request */
  faucetRequestStatus?: 'idle' | 'solving_pow' | 'requesting' | 'success' | 'error';
  /** Transaction ID from successful faucet request */
  faucetTxid?: string;
  /** Error message from failed faucet request */
  faucetError?: string;

  /** Mainnet: fund the deposit address from another asset via NEAR Intents */
  nearIntents?: NearIntentsState;
}

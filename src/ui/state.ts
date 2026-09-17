import type {
  BridgeState,
  BridgeStep,
  BridgeMode,
  KeyPair,
  UTXO,
  IdentityKeyConfig,
  DpnsUsernameEntry,
  DpnsRegistrationResult,
  DpnsIdentitySource,
  IdentityPublicKeyInfo,
  ManageNewKeyConfig,
  AssetLockProofData,
  NetworkStatus,
  OwnedUsername,
  UsernameTransferCredentialSource,
  UsernameTransferOutcome,
} from '../types.js';
import {
  generateDefaultIdentityKeysHD,
  generateIdentityKeyFromMnemonic,
} from '../crypto/keys.js';
import { generateNewMnemonic } from '../crypto/hd.js';
import { createEmptyUsernameEntry, createUsernameEntry } from '../platform/dpns-utils.js';
import { WithdrawalStatus } from '../platform/withdrawal-status.js';

/**
 * Error codes for user-facing display.
 * Each code maps to a specific failure category so users can report issues
 * with a reference that helps identify what went wrong.
 */
export const ErrorCodes = {
  UNKNOWN:          'ERR-1000',
  KEY_GEN:          'ERR-1001',
  TX_BUILD:         'ERR-1002',
  TX_SIGN:          'ERR-1003',
  BROADCAST:        'ERR-1004',
  ISLOCK:           'ERR-1005',
  REGISTER:         'ERR-1006',
  TOPUP:            'ERR-1007',
  SEND_ADDRESS:     'ERR-1008',
  DPNS_CHECK:       'ERR-1009',
  DPNS_REGISTER:    'ERR-1010',
  IDENTITY_UPDATE:  'ERR-1011',
  CONFIG:           'ERR-1012',
  CONTRACT_REGISTER: 'ERR-1013',
  CHAINLOCK:        'ERR-1014',
  WITHDRAW:         'ERR-1015',
  USERNAME_TRANSFER: 'ERR-1016',
} as const;

/** Human-readable labels for error codes */
export const ErrorCodeLabels: Record<string, string> = {
  [ErrorCodes.UNKNOWN]:         'Unknown error',
  [ErrorCodes.KEY_GEN]:         'Key generation failed',
  [ErrorCodes.TX_BUILD]:        'Transaction build failed',
  [ErrorCodes.TX_SIGN]:         'Transaction signing failed',
  [ErrorCodes.BROADCAST]:       'Transaction broadcast failed',
  [ErrorCodes.ISLOCK]:          'InstantSend lock failed',
  [ErrorCodes.REGISTER]:        'Identity registration failed',
  [ErrorCodes.TOPUP]:           'Identity top-up failed',
  [ErrorCodes.SEND_ADDRESS]:    'Send to address failed',
  [ErrorCodes.DPNS_CHECK]:      'Username availability check failed',
  [ErrorCodes.DPNS_REGISTER]:   'Username registration failed',
  [ErrorCodes.IDENTITY_UPDATE]: 'Identity update failed',
  [ErrorCodes.CONFIG]:          'Configuration error',
  [ErrorCodes.CONTRACT_REGISTER]: 'Contract registration failed',
  [ErrorCodes.CHAINLOCK]:        'Chain lock fallback failed',
  [ErrorCodes.WITHDRAW]:         'Credit withdrawal failed',
  [ErrorCodes.USERNAME_TRANSFER]: 'Username transfer failed',
};

/** Map a processing step to its error code */
const StepErrorCodes: Partial<Record<BridgeStep, string>> = {
  generating_keys:      ErrorCodes.KEY_GEN,
  building_transaction: ErrorCodes.TX_BUILD,
  signing_transaction:  ErrorCodes.TX_SIGN,
  broadcasting:         ErrorCodes.BROADCAST,
  waiting_islock:       ErrorCodes.ISLOCK,
  waiting_chainlock:    ErrorCodes.CHAINLOCK,
  registering_identity: ErrorCodes.REGISTER,
  topping_up:           ErrorCodes.TOPUP,
  sending_to_address:   ErrorCodes.SEND_ADDRESS,
  dpns_checking:        ErrorCodes.DPNS_CHECK,
  dpns_registering:     ErrorCodes.DPNS_REGISTER,
  manage_updating:      ErrorCodes.IDENTITY_UPDATE,
  contract_registering: ErrorCodes.CONTRACT_REGISTER,
  withdraw_submitting:  ErrorCodes.WITHDRAW,
  withdraw_tracking:    ErrorCodes.WITHDRAW,
  xfer_transferring:    ErrorCodes.USERNAME_TRANSFER,
};

/** Coerce an unknown caught value into an Error */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === 'object' && 'message' in value) {
    return new Error(String((value as { message: unknown }).message));
  }
  return new Error(String(value));
}

/**
 * Create initial bridge state (mode selection)
 * Keys are generated when mode is selected, not at init
 */
export function createInitialState(network: string): BridgeState {
  return {
    step: 'init',
    network,
    mode: 'create', // Default mode
    identityKeys: [],
  };
}

/**
 * State transition functions
 */
export function setStep(state: BridgeState, step: BridgeStep): BridgeState {
  return { ...state, step };
}

export function setKeyPairs(
  state: BridgeState,
  assetLockKeyPair: KeyPair,
  depositAddress: string
): BridgeState {
  return {
    ...state,
    step: 'awaiting_deposit',
    assetLockKeyPair,
    depositAddress,
  };
}

/**
 * Set bridge mode and transition to appropriate initial step.
 *
 * Note: a few transitions below assign `mode` directly rather than calling this,
 * and so bypass `clearModeSensitiveFields`. Those clear `fromManageMenu`
 * themselves, so the "only topup/withdraw can carry it" invariant holds
 * structurally rather than by reachability.
 */
export function setMode(state: BridgeState, mode: BridgeMode): BridgeState {
  const clearedState = clearModeSensitiveFields(state, mode);

  if (mode === 'create') {
    // Create mode: generate mnemonic and identity keys
    const mnemonic = generateNewMnemonic(128);
    return {
      ...clearedState,
      step: 'configure_keys',
      mode,
      mnemonic,
      identityKeys: generateDefaultIdentityKeysHD(clearedState.network, mnemonic),
      // Clear any top-up state
      targetIdentityId: undefined,
      isOneTimeKey: undefined,
    };
  } else if (mode === 'topup') {
    // Top-up mode: no mnemonic, no identity keys
    return {
      ...clearedState,
      step: 'enter_identity',
      mode,
      mnemonic: undefined,
      identityKeys: [],
      isOneTimeKey: true,
    };
  } else if (mode === 'send_to_address') {
    // Send to platform address mode: user enters recipient bech32m address
    return {
      ...clearedState,
      step: 'enter_recipient_address',
      mode,
      mnemonic: undefined,
      identityKeys: [],
      isOneTimeKey: true,
      recipientPlatformAddress: undefined,
    };
  } else if (mode === 'dpns') {
    // DPNS mode: go to identity source selection
    return {
      ...clearedState,
      step: 'dpns_choose_identity',
      mode,
      dpnsUsernames: [],
      dpnsResults: undefined,
      dpnsFromIdentityCreation: false,
      dpnsContestedWarningAcknowledged: false,
    };
  } else if (mode === 'contract') {
    // Contract mode: go to identity source selection
    return {
      ...clearedState,
      step: 'contract_choose_identity',
      mode,
      contractIdentitySource: undefined,
      contractJson: undefined,
      contractParsed: undefined,
      contractEstimate: undefined,
      contractParseError: undefined,
      contractFromIdentityCreation: false,
      contractPrivateKeyWif: undefined,
      contractPublicKeyId: undefined,
      contractIdentityKeys: undefined,
      contractIdentityFetching: undefined,
      contractIdentityFetchError: undefined,
      contractKeyValidated: undefined,
      contractKeyValidationError: undefined,
      contractRegisteredId: undefined,
      contractIdentityBalance: undefined,
      minimumDeposit: undefined,
    };
  } else if (mode === 'withdraw') {
    // Withdraw mode: go to identity entry, clear any previous withdraw state
    return {
      ...clearedState,
      step: 'withdraw_enter_identity',
      mode,
      mnemonic: undefined,
      identityKeys: [],
      targetIdentityId: undefined,
      withdrawIdentityFetching: undefined,
      withdrawIdentityFetchError: undefined,
      withdrawIdentityKeys: undefined,
      withdrawBalance: undefined,
      withdrawPrivateKeyWif: undefined,
      withdrawSigningKeyInfo: undefined,
      withdrawKeyValidationError: undefined,
      withdrawToAddress: undefined,
      withdrawAddressError: undefined,
      withdrawAmountCredits: undefined,
      withdrawAmountInput: undefined,
      withdrawAmountError: undefined,
      withdrawResult: undefined,
      withdrawStatus: undefined,
      withdrawStatusError: undefined,
    };
  } else {
    // Manage mode: choose between key management and username transfer
    return {
      ...clearedState,
      step: 'manage_choose_action',
      mode,
      // Clear any previous manage state
      manageKeysToAdd: [],
      manageKeyIdsToDisable: [],
      managePrivateKeyWif: undefined,
      manageSigningKeyInfo: undefined,
      manageIdentityFetching: undefined,
      manageIdentityFetchError: undefined,
      manageIdentityKeys: undefined,
      manageUpdateResult: undefined,
      manageKeyValidationError: undefined,
      targetIdentityId: undefined,
    };
  }
}

function clearModeSensitiveFields(state: BridgeState, mode: BridgeMode): BridgeState {
  // setMode('withdraw') re-clears the withdraw block itself, so these can be
  // dropped unconditionally here.
  return {
    // Drop the transfer flow's credentials on any mode switch. `xferMnemonic`
    // is the user's real wallet seed, so it must not outlive the flow that
    // asked for it.
    ...clearUsernameTransferFields(state),
    // Re-entering a mode from the init screen or a deep link means we did not
    // come through the Manage Identity menu; the chooser re-sets this itself.
    fromManageMenu: undefined,
    recipientPlatformAddress: mode === 'send_to_address' ? state.recipientPlatformAddress : undefined,
    withdrawPrivateKeyWif: undefined,
    withdrawSigningKeyInfo: undefined,
    withdrawToAddress: undefined,
    withdrawAmountCredits: undefined,
  };
}

/**
 * Set target identity ID for top-up
 */
export function setTargetIdentityId(state: BridgeState, targetIdentityId: string): BridgeState {
  return {
    ...state,
    targetIdentityId,
  };
}

/**
 * Set one-time key pair for top-up (random, not HD-derived)
 */
export function setOneTimeKeyPair(
  state: BridgeState,
  assetLockKeyPair: KeyPair,
  depositAddress: string
): BridgeState {
  return {
    ...state,
    step: 'awaiting_deposit',
    assetLockKeyPair,
    depositAddress,
    isOneTimeKey: true,
  };
}

/**
 * Set top-up complete
 */
export function setTopUpComplete(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'complete',
    identityId: state.targetIdentityId, // Use target identity ID on completion
  };
}

/**
 * Set recipient platform address for send_to_address mode
 */
export function setRecipientPlatformAddress(
  state: BridgeState,
  recipientPlatformAddress: string
): BridgeState {
  return {
    ...state,
    recipientPlatformAddress,
  };
}

/**
 * Set send to address complete
 */
export function setSendToAddressComplete(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'complete',
  };
}

/**
 * Update a specific identity key's configuration
 */
export function updateIdentityKey(
  state: BridgeState,
  keyId: number,
  updates: Partial<Pick<IdentityKeyConfig, 'keyType' | 'purpose' | 'securityLevel' | 'name'>>
): BridgeState {
  if (!state.mnemonic) {
    throw new Error('No mnemonic available for HD derivation');
  }

  const identityKeys = state.identityKeys.map((key, index) => {
    if (key.id !== keyId) return key;

    // Determine effective purpose and security level
    const effectivePurpose = updates.purpose ?? key.purpose;
    let effectiveSecurityLevel = updates.securityLevel ?? key.securityLevel;

    // TRANSFER purpose only allows CRITICAL security level
    if (effectivePurpose === 'TRANSFER' && effectiveSecurityLevel !== 'CRITICAL') {
      effectiveSecurityLevel = 'CRITICAL';
    }

    // If keyType changed, regenerate with new type using HD derivation
    if (updates.keyType && updates.keyType !== key.keyType) {
      return generateIdentityKeyFromMnemonic(
        key.id,
        updates.name ?? key.name,
        updates.keyType,
        effectivePurpose,
        effectiveSecurityLevel,
        state.network,
        state.mnemonic!,
        index // Use array index as key index
      );
    }

    return {
      ...key,
      ...updates,
      purpose: effectivePurpose,
      securityLevel: effectiveSecurityLevel,
    };
  });

  return { ...state, identityKeys };
}

/**
 * Add a new identity key using HD derivation
 */
export function addIdentityKey(state: BridgeState): BridgeState {
  if (!state.mnemonic) {
    throw new Error('No mnemonic available for HD derivation');
  }

  const nextId = Math.max(...state.identityKeys.map((k) => k.id)) + 1;
  const keyIndex = state.identityKeys.length; // Use array length as key index

  const newKey = generateIdentityKeyFromMnemonic(
    nextId,
    `Key ${nextId}`,
    'ECDSA_SECP256K1',
    'AUTHENTICATION',
    'HIGH',
    state.network,
    state.mnemonic,
    keyIndex
  );

  return {
    ...state,
    identityKeys: [...state.identityKeys, newKey],
  };
}

/**
 * Remove an identity key
 */
export function removeIdentityKey(state: BridgeState, keyId: number): BridgeState {
  // Don't allow removing the last key
  if (state.identityKeys.length <= 1) return state;

  return {
    ...state,
    identityKeys: state.identityKeys.filter((k) => k.id !== keyId),
  };
}

/**
 * Regenerate all identity keys from mnemonic (re-derives with same paths)
 */
export function regenerateAllIdentityKeys(state: BridgeState): BridgeState {
  if (!state.mnemonic) {
    throw new Error('No mnemonic available for HD derivation');
  }

  const identityKeys = state.identityKeys.map((key, index) =>
    generateIdentityKeyFromMnemonic(
      key.id,
      key.name,
      key.keyType,
      key.purpose,
      key.securityLevel,
      state.network,
      state.mnemonic!,
      index
    )
  );

  return { ...state, identityKeys };
}

export function setUtxoDetected(state: BridgeState, utxo: UTXO): BridgeState {
  return {
    ...state,
    step: 'building_transaction',
    detectedUtxo: utxo,
    depositAmount: BigInt(utxo.satoshis),
  };
}

export function setTransactionSigned(
  state: BridgeState,
  signedTxHex: string,
  signedTxBytes?: Uint8Array
): BridgeState {
  return {
    ...state,
    step: 'broadcasting',
    signedTxHex,
    signedTxBytes,
  };
}

export function setTransactionBroadcast(
  state: BridgeState,
  txid: string
): BridgeState {
  return {
    ...state,
    step: 'waiting_islock',
    txid,
  };
}

export function setInstantLockReceived(
  state: BridgeState,
  instantLockBytes: Uint8Array,
  assetLockProof: AssetLockProofData
): BridgeState {
  return {
    ...state,
    step: 'registering_identity',
    instantLockBytes,
    assetLockProof,
  };
}

export function setIdentityRegistered(
  state: BridgeState,
  identityId: string
): BridgeState {
  return {
    ...state,
    step: 'complete',
    identityId,
  };
}

/**
 * Determine whether the chainlock fallback can be offered for the given
 * error code. Available when:
 *   - islock retrieval failed outright (ERR-1005), OR
 *   - A chain-lock wait was cancelled/failed and the same tx can be resumed.
 *   - Platform rejected a submission that already had a typed asset lock
 *     proof in hand (REGISTER / TOPUP / SEND_ADDRESS), AND we still hold
 *     the broadcast txid + signed tx bytes needed to rebuild the proof.
 */
function computeChainlockFallbackAvailable(
  state: BridgeState,
  errorCode: string
): boolean {
  if (errorCode === ErrorCodes.ISLOCK || errorCode === ErrorCodes.CHAINLOCK) {
    return !!state.txid;
  }
  if (
    errorCode === ErrorCodes.REGISTER ||
    errorCode === ErrorCodes.TOPUP ||
    errorCode === ErrorCodes.SEND_ADDRESS
  ) {
    return !!(state.txid && state.signedTxBytes);
  }
  return false;
}

export function setError(state: BridgeState, error: Error, errorCode?: string): BridgeState {
  const resolvedCode = errorCode ?? StepErrorCodes[state.step] ?? ErrorCodes.UNKNOWN;
  return {
    ...state,
    step: 'error',
    error,
    errorCode: resolvedCode,
    errorStep: state.step,
    chainlockFallbackAvailable: computeChainlockFallbackAvailable(state, resolvedCode),
  };
}

/**
 * Transition into the chainlock-fallback waiting step. Clears the prior
 * error so the UI swaps the error screen for the new spinner.
 */
export function setChainlockFallbackStarted(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'waiting_chainlock',
    error: undefined,
    errorCode: undefined,
    errorStep: undefined,
    chainlockFallbackAvailable: undefined,
    assetLockTxBlockHeight: undefined,
    coreChainLockedHeight: undefined,
  };
}

/**
 * Update the chainlock-fallback poller progress. Either height can be
 * undefined while we wait for the first observation.
 */
export function setChainlockProgress(
  state: BridgeState,
  progress: { blockHeight?: number; chainLockedHeight?: number }
): BridgeState {
  return {
    ...state,
    assetLockTxBlockHeight: progress.blockHeight,
    coreChainLockedHeight: progress.chainLockedHeight,
  };
}

/**
 * Chainlock proof assembled — flow continues via the mode-specific
 * Platform submission, which sets its own step.
 */
export function setChainlockProofReady(
  state: BridgeState,
  proof: AssetLockProofData
): BridgeState {
  return {
    ...state,
    assetLockProof: proof,
  };
}

/**
 * Update the network-health snapshot shown in the header indicator.
 */
export function setNetworkStatus(
  state: BridgeState,
  networkStatus: NetworkStatus
): BridgeState {
  return { ...state, networkStatus };
}

/**
 * Set network (re-derives identity keys for new network from same mnemonic)
 */
export function setNetwork(
  state: BridgeState,
  network: string
): BridgeState {
  if (!state.mnemonic) {
    // Fallback: generate new mnemonic if none exists
    const mnemonic = generateNewMnemonic(128);
    return {
      ...state,
      network,
      mnemonic,
      identityKeys: generateDefaultIdentityKeysHD(network, mnemonic),
    };
  }

  // Re-derive keys with same mnemonic for new network (derivation paths change)
  const identityKeys = state.identityKeys.map((key, index) =>
    generateIdentityKeyFromMnemonic(
      key.id,
      key.name,
      key.keyType,
      key.purpose,
      key.securityLevel,
      network,
      state.mnemonic!,
      index
    )
  );

  return {
    ...state,
    network,
    identityKeys,
  };
}

/**
 * Set deposit timeout state (shows recheck button when true)
 */
export function setDepositTimedOut(
  state: BridgeState,
  timedOut: boolean,
  detectedAmount?: number
): BridgeState {
  return {
    ...state,
    depositTimedOut: timedOut,
    detectedDepositAmount: detectedAmount,
  };
}

/**
 * Get human-readable step description
 */
export function getStepDescription(step: BridgeStep): string {
  const descriptions: Record<BridgeStep, string> = {
    init: 'Ready to start',
    configure_keys: 'Configure your keys',
    enter_identity: 'Top up identity',
    generating_keys: 'Preparing Dash Platform...',
    awaiting_deposit: 'Fund your identity',
    detecting_deposit: 'Fund your identity',
    building_transaction: 'Preparing transaction...',
    signing_transaction: 'Signing...',
    broadcasting: 'Submitting to network...',
    waiting_islock: 'Confirming...',
    waiting_chainlock: 'Waiting for chain lock...',
    registering_identity: 'Creating identity...',
    topping_up: 'Adding credits...',
    enter_recipient_address: 'Send to platform address',
    sending_to_address: 'Sending to address...',
    complete: 'Complete',
    error: 'Something went wrong',
    // DPNS steps
    dpns_choose_identity: 'Register username',
    dpns_enter_identity: 'Enter identity',
    dpns_enter_usernames: 'Choose usernames',
    dpns_checking: 'Checking availability...',
    dpns_review: 'Review usernames',
    dpns_registering: 'Registering...',
    dpns_complete: 'Registration complete',
    // Identity Management steps
    manage_choose_action: 'Manage identity',
    manage_enter_identity: 'Manage identity',
    manage_view_keys: 'Manage keys',
    manage_updating: 'Updating identity...',
    manage_complete: 'Update complete',
    // Username transfer steps
    xfer_credentials: 'Unlock your identity',
    xfer_select_username: 'Choose a username',
    xfer_review: 'Confirm transfer',
    xfer_transferring: 'Transferring username...',
    xfer_complete: 'Transfer complete',
    // Contract registration steps
    contract_choose_identity: 'Register contract',
    contract_enter_identity: 'Enter identity',
    contract_enter_contract: 'Enter contract',
    contract_review: 'Review contract',
    contract_registering: 'Publishing contract...',
    contract_complete: 'Contract registered',
    // Withdraw steps
    withdraw_enter_identity: 'Withdraw credits',
    withdraw_configure: 'Configure withdrawal',
    withdraw_submitting: 'Submitting withdrawal...',
    withdraw_tracking: 'Processing withdrawal...',
    withdraw_complete: 'Withdrawal complete',
  };
  return descriptions[step];
}

/**
 * Get progress percentage for background progress bar (0-100)
 */
export function getStepProgress(step: BridgeStep): number {
  const progress: Record<BridgeStep, number> = {
    init: 0,
    configure_keys: 10,
    enter_identity: 10,
    generating_keys: 20,
    awaiting_deposit: 30,
    detecting_deposit: 30,
    building_transaction: 50,
    signing_transaction: 60,
    broadcasting: 70,
    waiting_islock: 80,
    waiting_chainlock: 85,
    registering_identity: 90,
    topping_up: 90,
    enter_recipient_address: 10,
    sending_to_address: 90,
    complete: 100,
    error: 0,
    // DPNS steps
    dpns_choose_identity: 10,
    dpns_enter_identity: 20,
    dpns_enter_usernames: 30,
    dpns_checking: 50,
    dpns_review: 60,
    dpns_registering: 80,
    dpns_complete: 100,
    // Identity Management steps
    manage_choose_action: 10,
    manage_enter_identity: 20,
    manage_view_keys: 40,
    manage_updating: 70,
    manage_complete: 100,
    // Username transfer steps
    xfer_credentials: 20,
    xfer_select_username: 40,
    xfer_review: 60,
    xfer_transferring: 85,
    xfer_complete: 100,
    // Contract registration steps
    contract_choose_identity: 10,
    contract_enter_identity: 20,
    contract_enter_contract: 40,
    contract_review: 60,
    contract_registering: 80,
    contract_complete: 100,
    // Withdraw steps
    withdraw_enter_identity: 20,
    withdraw_configure: 40,
    withdraw_submitting: 70,
    withdraw_tracking: 85,
    withdraw_complete: 100,
  };
  return progress[step];
}

/**
 * Check if the current step is a loading/processing step
 */
export function isProcessingStep(step: BridgeStep): boolean {
  const processingSteps: BridgeStep[] = [
    'generating_keys',
    // detecting_deposit is NOT a processing step - it's waiting for user action
    'building_transaction',
    'signing_transaction',
    'broadcasting',
    'waiting_islock',
    'waiting_chainlock',
    'registering_identity',
    'topping_up',
    'sending_to_address',
    // DPNS processing steps
    'dpns_checking',
    'dpns_registering',
    // Identity Management processing steps
    'manage_updating',
    // Username transfer processing steps
    'xfer_transferring',
    // Contract registration processing steps
    'contract_registering',
    // Withdraw processing steps
    'withdraw_submitting',
    'withdraw_tracking',
  ];
  return processingSteps.includes(step);
}

// ============================================================================
// DPNS State Functions
// ============================================================================

/**
 * Enter DPNS mode from identity creation complete screen
 */
export function setModeDpnsFromIdentity(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'dpns_enter_usernames',
    mode: 'dpns',
    dpnsUsernames: [createEmptyUsernameEntry()],
    dpnsResults: undefined,
    dpnsFromIdentityCreation: true,
    dpnsContestedWarningAcknowledged: false,
    // identityId is already set from creation flow
    // Use the first identity key for DPNS registration
    dpnsPublicKeyId: 0,
  };
}

/**
 * Set DPNS identity source choice
 */
export function setDpnsIdentitySource(
  state: BridgeState,
  source: DpnsIdentitySource
): BridgeState {
  if (source === 'new') {
    // Go to identity creation, but remember we're coming back to DPNS
    const mnemonic = generateNewMnemonic(128);
    return {
      ...state,
      step: 'configure_keys',
      mode: 'create', // Switch to create mode temporarily
      fromManageMenu: undefined,
      mnemonic,
      identityKeys: generateDefaultIdentityKeysHD(state.network, mnemonic),
      dpnsIdentitySource: source,
      dpnsFromIdentityCreation: true, // Will return to DPNS after creation
    };
  }

  return {
    ...state,
    step: 'dpns_enter_identity',
    dpnsIdentitySource: source,
  };
}

/**
 * Set existing identity for DPNS registration
 */
export function setDpnsExistingIdentity(
  state: BridgeState,
  identityId: string,
  privateKeyWif: string,
  publicKeyId: number = 0
): BridgeState {
  return {
    ...state,
    step: 'dpns_enter_usernames',
    targetIdentityId: identityId,
    identityId: identityId,
    dpnsPrivateKeyWif: privateKeyWif,
    dpnsPublicKeyId: publicKeyId,
    dpnsUsernames: [createEmptyUsernameEntry()],
  };
}

/**
 * Start fetching identity for DPNS validation
 */
export function setDpnsIdentityFetching(state: BridgeState, identityId: string): BridgeState {
  return {
    ...state,
    targetIdentityId: identityId,
    dpnsIdentityFetching: true,
    dpnsIdentityFetchError: undefined,
    dpnsIdentityKeys: undefined,
    dpnsValidatedKeyId: undefined,
    dpnsKeyValidationError: undefined,
  };
}

/**
 * Identity fetch succeeded with keys
 */
export function setDpnsIdentityFetched(
  state: BridgeState,
  keys: import('../types.js').IdentityPublicKeyInfo[]
): BridgeState {
  return {
    ...state,
    dpnsIdentityFetching: false,
    dpnsIdentityFetchError: undefined,
    dpnsIdentityKeys: keys,
  };
}

/**
 * Identity fetch failed
 */
export function setDpnsIdentityFetchError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    dpnsIdentityFetching: false,
    dpnsIdentityFetchError: error,
    dpnsIdentityKeys: undefined,
  };
}

/**
 * Key validation succeeded
 */
export function setDpnsKeyValidated(
  state: BridgeState,
  keyId: number,
  privateKeyWif: string
): BridgeState {
  return {
    ...state,
    dpnsValidatedKeyId: keyId,
    dpnsPublicKeyId: keyId,
    dpnsPrivateKeyWif: privateKeyWif,
    dpnsKeyValidationError: undefined,
  };
}

/**
 * Key validation failed
 */
export function setDpnsKeyValidationError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    dpnsValidatedKeyId: undefined,
    dpnsKeyValidationError: error,
  };
}

/**
 * Clear DPNS key validation state (when private key input changes)
 */
export function clearDpnsKeyValidation(state: BridgeState): BridgeState {
  return {
    ...state,
    dpnsValidatedKeyId: undefined,
    dpnsKeyValidationError: undefined,
    dpnsPrivateKeyWif: undefined,
  };
}

/**
 * Add a username to the DPNS list
 */
export function addDpnsUsername(state: BridgeState): BridgeState {
  return {
    ...state,
    dpnsUsernames: [...(state.dpnsUsernames || []), createEmptyUsernameEntry()],
  };
}

/**
 * Update a username in the DPNS list
 */
export function updateDpnsUsername(
  state: BridgeState,
  index: number,
  label: string
): BridgeState {
  const usernames = [...(state.dpnsUsernames || [])];
  usernames[index] = createUsernameEntry(label);
  return { ...state, dpnsUsernames: usernames };
}

/**
 * Remove a username from the DPNS list
 */
export function removeDpnsUsername(state: BridgeState, index: number): BridgeState {
  const usernames = (state.dpnsUsernames || []).filter((_, i) => i !== index);
  return {
    ...state,
    dpnsUsernames: usernames.length > 0 ? usernames : [createEmptyUsernameEntry()],
  };
}

/**
 * Set step to checking availability
 */
export function setDpnsChecking(state: BridgeState): BridgeState {
  // Mark all valid usernames as checking
  const usernames = (state.dpnsUsernames || []).map((u) => ({
    ...u,
    status: u.isValid ? 'checking' as const : u.status,
  }));

  return {
    ...state,
    step: 'dpns_checking',
    dpnsUsernames: usernames,
  };
}

/**
 * Set username availability check results
 */
export function setDpnsAvailability(
  state: BridgeState,
  results: DpnsUsernameEntry[]
): BridgeState {
  return {
    ...state,
    step: 'dpns_review',
    dpnsUsernames: results,
  };
}

/**
 * Acknowledge contested names warning
 */
export function acknowledgeDpnsContestedWarning(state: BridgeState): BridgeState {
  return {
    ...state,
    dpnsContestedWarningAcknowledged: true,
  };
}

/**
 * Set DPNS registration in progress
 */
export function setDpnsRegistering(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'dpns_registering',
    dpnsRegistrationProgress: 0,
  };
}

/**
 * Update DPNS registration progress
 */
export function setDpnsRegistrationProgress(
  state: BridgeState,
  progress: number
): BridgeState {
  return {
    ...state,
    dpnsRegistrationProgress: progress,
  };
}

/**
 * Set DPNS registration results
 */
export function setDpnsResults(
  state: BridgeState,
  results: DpnsRegistrationResult[]
): BridgeState {
  return {
    ...state,
    step: 'dpns_complete',
    dpnsResults: results,
  };
}

/**
 * Reset DPNS state for registering more names
 */
export function resetDpnsForMore(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'dpns_enter_usernames',
    dpnsUsernames: [createEmptyUsernameEntry()],
    dpnsResults: undefined,
    dpnsContestedWarningAcknowledged: false,
    dpnsRegistrationProgress: undefined,
  };
}

/**
 * Go back to DPNS username entry from review
 */
export function setDpnsBackToEntry(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'dpns_enter_usernames',
  };
}

// ============================================================================
// Identity Management State Functions
// ============================================================================

/**
 * Start fetching identity for management
 */
export function setManageIdentityFetching(state: BridgeState, identityId: string): BridgeState {
  return {
    ...state,
    targetIdentityId: identityId,
    manageIdentityFetching: true,
    manageIdentityFetchError: undefined,
    manageIdentityKeys: undefined,
    manageSigningKeyInfo: undefined,
    manageKeyValidationError: undefined,
  };
}

/**
 * Identity fetch succeeded
 */
export function setManageIdentityFetched(
  state: BridgeState,
  keys: IdentityPublicKeyInfo[]
): BridgeState {
  return {
    ...state,
    manageIdentityFetching: false,
    manageIdentityFetchError: undefined,
    manageIdentityKeys: keys,
  };
}

/**
 * Identity fetch failed
 */
export function setManageIdentityFetchError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    manageIdentityFetching: false,
    manageIdentityFetchError: error,
    manageIdentityKeys: undefined,
  };
}

/**
 * Validate signing key and proceed to key management view
 */
export function setManageKeyValidated(
  state: BridgeState,
  keyId: number,
  securityLevel: number,
  privateKeyWif: string
): BridgeState {
  return {
    ...state,
    step: 'manage_view_keys',
    managePrivateKeyWif: privateKeyWif,
    manageSigningKeyInfo: { keyId, securityLevel },
    manageKeyValidationError: undefined,
  };
}

/**
 * Key validation failed
 */
export function setManageKeyValidationError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    manageSigningKeyInfo: undefined,
    manageKeyValidationError: error,
  };
}

/**
 * Clear manage key validation state (when private key input changes)
 */
export function clearManageKeyValidation(state: BridgeState): BridgeState {
  return {
    ...state,
    manageSigningKeyInfo: undefined,
    manageKeyValidationError: undefined,
    managePrivateKeyWif: undefined,
  };
}

/**
 * Add a new key to be added
 */
export function addManageNewKey(state: BridgeState, config: ManageNewKeyConfig): BridgeState {
  return {
    ...state,
    manageKeysToAdd: [...(state.manageKeysToAdd || []), config],
  };
}

/**
 * Remove a key from the add list
 */
export function removeManageNewKey(state: BridgeState, tempId: string): BridgeState {
  return {
    ...state,
    manageKeysToAdd: (state.manageKeysToAdd || []).filter(k => k.tempId !== tempId),
  };
}

/**
 * Update a key in the add list
 */
export function updateManageNewKey(
  state: BridgeState,
  tempId: string,
  updates: Partial<ManageNewKeyConfig>
): BridgeState {
  return {
    ...state,
    manageKeysToAdd: (state.manageKeysToAdd || []).map(k => {
      if (k.tempId !== tempId) return k;

      // Determine effective purpose and security level
      const effectivePurpose = updates.purpose ?? k.purpose;
      let effectiveSecurityLevel = updates.securityLevel ?? k.securityLevel;

      // TRANSFER purpose only allows CRITICAL security level
      if (effectivePurpose === 'TRANSFER' && effectiveSecurityLevel !== 'CRITICAL') {
        effectiveSecurityLevel = 'CRITICAL';
      }

      return {
        ...k,
        ...updates,
        purpose: effectivePurpose,
        securityLevel: effectiveSecurityLevel,
      };
    }),
  };
}

/**
 * Toggle a key for disabling
 */
export function toggleManageDisableKey(state: BridgeState, keyId: number): BridgeState {
  const current = state.manageKeyIdsToDisable || [];
  const isDisabled = current.includes(keyId);

  return {
    ...state,
    manageKeyIdsToDisable: isDisabled
      ? current.filter(id => id !== keyId)
      : [...current, keyId],
  };
}

/**
 * Start the update transition
 */
export function setManageUpdating(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'manage_updating',
  };
}

/**
 * Update complete
 */
export function setManageComplete(
  state: BridgeState,
  result: { success: boolean; error?: string }
): BridgeState {
  return {
    ...state,
    step: 'manage_complete',
    manageUpdateResult: result,
  };
}

/**
 * Reset manage state to try again or start over
 */
export function resetManageState(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'manage_view_keys',
    manageKeysToAdd: [],
    manageKeyIdsToDisable: [],
    manageUpdateResult: undefined,
  };
}

/**
 * Reset manage state and prepare to refresh identity keys
 * Used after a successful update to get fresh key data
 */
export function resetManageStateAndRefresh(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'manage_view_keys',
    manageKeysToAdd: [],
    manageKeyIdsToDisable: [],
    manageUpdateResult: undefined,
    manageIdentityKeys: undefined,
    manageIdentityFetching: true,
  };
}

/**
 * Go back to manage enter identity step
 */
export function setManageBackToEntry(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'manage_enter_identity',
    // Keep identity ID and keys, just clear validation
    manageSigningKeyInfo: undefined,
    managePrivateKeyWif: undefined,
    manageKeyValidationError: undefined,
    manageKeysToAdd: [],
    manageKeyIdsToDisable: [],
  };
}

// ============================================================================
// Username Transfer State Functions
// ============================================================================

/**
 * Clear every field belonging to the username transfer sub-flow.
 */
export function clearUsernameTransferFields(state: BridgeState): BridgeState {
  return {
    ...state,
    xferCredentialSource: undefined,
    xferMnemonic: undefined,
    xferDiscoveryStatus: undefined,
    xferCredentialError: undefined,
    xferPrivateKeyWif: undefined,
    xferSigningKeyInfo: undefined,
    xferOwnedUsernames: undefined,
    xferOtherIdentities: undefined,
    xferSelectedUsername: undefined,
    xferRecipientId: undefined,
    xferRecipientError: undefined,
    xferRecipientVerified: undefined,
    xferRecipientChecking: undefined,
    xferProtocolVersion: undefined,
    xferConfirmationAcknowledged: undefined,
    xferResult: undefined,
  };
}

/**
 * Manage mode: choose the key management path
 */
export function setManageActionKeys(state: BridgeState): BridgeState {
  return {
    ...clearUsernameTransferFields(state),
    step: 'manage_enter_identity',
    targetIdentityId: undefined,
  };
}

/**
 * Manage mode: choose the username transfer path
 */
export function setManageActionTransfer(state: BridgeState): BridgeState {
  return {
    ...clearUsernameTransferFields(state),
    step: 'xfer_credentials',
    targetIdentityId: undefined,
  };
}

/**
 * Manage mode: choose top-up. Unlike keys and transfer this is its own mode, so
 * it goes through setMode and then records that the menu was the entry point.
 */
export function setManageActionTopUp(state: BridgeState): BridgeState {
  return { ...setMode(state, 'topup'), fromManageMenu: true };
}

/**
 * Manage mode: choose credit withdrawal. Also its own mode.
 */
export function setManageActionWithdraw(state: BridgeState): BridgeState {
  return { ...setMode(state, 'withdraw'), fromManageMenu: true };
}

/**
 * Switch between seed phrase and identity ID + WIF credential entry
 */
export function setXferCredentialSource(
  state: BridgeState,
  source: UsernameTransferCredentialSource
): BridgeState {
  return {
    ...state,
    xferCredentialSource: source,
    xferCredentialError: undefined,
    xferDiscoveryStatus: undefined,
    xferSigningKeyInfo: undefined,
    xferPrivateKeyWif: undefined,
  };
}

/**
 * Record seed phrase input without validating it yet
 */
export function setXferMnemonic(state: BridgeState, mnemonic: string): BridgeState {
  return {
    ...state,
    xferMnemonic: mnemonic,
    xferCredentialError: undefined,
  };
}

/**
 * Start identity discovery / unlock
 */
export function setXferDiscovering(state: BridgeState, status: string): BridgeState {
  return {
    ...state,
    xferDiscoveryStatus: status,
    xferCredentialError: undefined,
  };
}

/**
 * Update the discovery progress message without leaving the discovering state
 */
export function setXferDiscoveryStatus(state: BridgeState, status: string): BridgeState {
  return {
    ...state,
    xferDiscoveryStatus: status,
  };
}

/**
 * Discovery or credential validation failed
 */
export function setXferCredentialError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    xferDiscoveryStatus: undefined,
    xferCredentialError: error,
  };
}

/**
 * Credentials accepted: we know the identity, its signing key, and what it owns
 */
export function setXferIdentityUnlocked(
  state: BridgeState,
  params: {
    identityId: string;
    privateKeyWif: string;
    keyId: number;
    securityLevel: number;
    usernames: OwnedUsername[];
    protocolVersion?: number;
    otherIdentities?: string[];
  }
): BridgeState {
  return {
    ...state,
    step: 'xfer_select_username',
    targetIdentityId: params.identityId,
    xferDiscoveryStatus: undefined,
    xferCredentialError: undefined,
    xferPrivateKeyWif: params.privateKeyWif,
    xferSigningKeyInfo: { keyId: params.keyId, securityLevel: params.securityLevel },
    xferOwnedUsernames: params.usernames,
    xferOtherIdentities: params.otherIdentities,
    xferProtocolVersion: params.protocolVersion,
    // Preselect when there is only one name to choose from.
    xferSelectedUsername: params.usernames.length === 1 ? params.usernames[0].username : undefined,
  };
}

/**
 * Select which username to transfer
 */
export function setXferSelectedUsername(state: BridgeState, username: string): BridgeState {
  return {
    ...state,
    xferSelectedUsername: username,
  };
}

/**
 * Record the destination identity ID. Any edit invalidates a previous check.
 */
export function setXferRecipientId(state: BridgeState, recipientId: string): BridgeState {
  return {
    ...state,
    xferRecipientId: recipientId,
    xferRecipientVerified: undefined,
    xferRecipientError: undefined,
  };
}

/**
 * Start verifying that the recipient identity exists
 */
export function setXferRecipientChecking(state: BridgeState): BridgeState {
  return {
    ...state,
    xferRecipientChecking: true,
    xferRecipientError: undefined,
    xferRecipientVerified: undefined,
  };
}

/**
 * Recipient identity confirmed to exist on Platform
 */
export function setXferRecipientVerified(state: BridgeState): BridgeState {
  return {
    ...state,
    xferRecipientChecking: false,
    xferRecipientVerified: true,
    xferRecipientError: undefined,
  };
}

/**
 * Recipient identity could not be confirmed.
 *
 * This is a hard gate rather than a warning: Platform does not check that a
 * transfer recipient exists, so a mistyped ID would orphan the username.
 */
export function setXferRecipientError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    xferRecipientChecking: false,
    xferRecipientVerified: false,
    xferRecipientError: error,
  };
}

/**
 * Move to the confirmation screen
 */
export function setXferReview(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'xfer_review',
    xferConfirmationAcknowledged: false,
  };
}

/**
 * Toggle the "I understand this is irreversible" checkbox
 */
export function setXferConfirmationAcknowledged(
  state: BridgeState,
  acknowledged: boolean
): BridgeState {
  return {
    ...state,
    xferConfirmationAcknowledged: acknowledged,
  };
}

/**
 * Start the transfer
 */
export function setXferTransferring(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'xfer_transferring',
  };
}

/**
 * Transfer finished (successfully or not).
 *
 * On success the seed phrase and signing key are dropped — nothing downstream
 * needs them. On failure they are kept, since "Try Again" signs again.
 */
export function setXferResult(
  state: BridgeState,
  result: UsernameTransferOutcome
): BridgeState {
  return {
    ...state,
    step: 'xfer_complete',
    xferResult: result,
    xferMnemonic: result.success ? undefined : state.xferMnemonic,
    xferPrivateKeyWif: result.success ? undefined : state.xferPrivateKeyWif,
  };
}

/**
 * Go back to credential entry, keeping the seed phrase the user typed
 */
export function setXferBackToCredentials(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'xfer_credentials',
    xferSigningKeyInfo: undefined,
    xferPrivateKeyWif: undefined,
    xferOwnedUsernames: undefined,
    xferOtherIdentities: undefined,
    xferSelectedUsername: undefined,
    xferRecipientId: undefined,
    xferRecipientVerified: undefined,
    xferRecipientError: undefined,
    xferConfirmationAcknowledged: undefined,
  };
}

/**
 * Go back to username selection from the review screen
 */
export function setXferBackToSelect(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'xfer_select_username',
    xferConfirmationAcknowledged: undefined,
  };
}

// ============================================================================
// Contract Registration State Functions
// ============================================================================

/**
 * Set contract identity source and transition accordingly
 */
export function setContractIdentitySource(state: BridgeState, source: 'new' | 'existing'): BridgeState {
  if (source === 'new') {
    // New identity: go to contract entry first (need fee estimate before deposit)
    return {
      ...state,
      step: 'contract_enter_contract',
      contractIdentitySource: 'new',
    };
  }
  // Existing identity: go to identity entry
  return {
    ...state,
    step: 'contract_enter_identity',
    contractIdentitySource: 'existing',
  };
}

/**
 * Set contract identity fetching state
 */
export function setContractIdentityFetching(state: BridgeState, identityId: string): BridgeState {
  return {
    ...state,
    targetIdentityId: identityId,
    contractIdentityFetching: true,
    contractIdentityFetchError: undefined,
    contractIdentityKeys: undefined,
    contractIdentityBalance: undefined,
  };
}

/**
 * Set contract identity fetched with keys and optional balance
 */
export function setContractIdentityFetched(
  state: BridgeState,
  keys: IdentityPublicKeyInfo[],
  balance?: number,
): BridgeState {
  return {
    ...state,
    contractIdentityFetching: false,
    contractIdentityKeys: keys,
    contractIdentityBalance: balance,
    contractIdentityFetchError: undefined,
  };
}

/**
 * Set contract identity fetch error
 */
export function setContractIdentityFetchError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    contractIdentityFetching: false,
    contractIdentityFetchError: error,
    contractIdentityKeys: undefined,
  };
}

/**
 * Set contract key validated
 */
export function setContractKeyValidated(state: BridgeState, keyId: number, privateKeyWif: string): BridgeState {
  return {
    ...state,
    contractKeyValidated: true,
    contractPublicKeyId: keyId,
    contractPrivateKeyWif: privateKeyWif,
    contractKeyValidationError: undefined,
  };
}

/**
 * Set contract key validation error
 */
export function setContractKeyValidationError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    contractKeyValidated: false,
    contractKeyValidationError: error,
    contractPrivateKeyWif: undefined,
    contractPublicKeyId: undefined,
  };
}

/**
 * Update contract JSON with live parse/estimate results
 */
export function setContractJson(
  state: BridgeState,
  json: string,
  parsed?: BridgeState['contractParsed'],
  estimate?: BridgeState['contractEstimate'],
  parseError?: string,
): BridgeState {
  return {
    ...state,
    contractJson: json,
    contractParsed: parsed,
    contractEstimate: estimate,
    contractParseError: parseError,
  };
}

/**
 * Transition to contract review step, calculating deposit for new-identity route
 */
export function setContractReview(state: BridgeState): BridgeState {
  let minimumDeposit = state.minimumDeposit;
  if (state.contractIdentitySource === 'new' && state.contractEstimate) {
    const CREDITS_PER_SATOSHI = 1000; // 1 Dash = 100M satoshis = 100B credits
    const feeCredits = state.contractEstimate.totalCredits;
    const feeSatoshis = Math.ceil(feeCredits / CREDITS_PER_SATOSHI);
    const excessSatoshis = 10_000_000; // 0.1 Dash buffer
    const txFee = 1000;
    minimumDeposit = feeSatoshis + excessSatoshis + txFee;
  }
  return {
    ...state,
    step: 'contract_review',
    minimumDeposit,
  };
}

/**
 * Transition to contract registering step
 */
export function setContractRegistering(state: BridgeState): BridgeState {
  return { ...state, step: 'contract_registering' };
}

/**
 * Set contract registration complete
 */
export function setContractComplete(state: BridgeState, contractId: string): BridgeState {
  return {
    ...state,
    step: 'contract_complete',
    contractRegisteredId: contractId,
  };
}

/**
 * Transition from identity creation complete screen to contract entry.
 * Preserves identity info (identityId, mnemonic, keys) for contract publishing.
 */
export function setModeContractFromIdentity(state: BridgeState): BridgeState {
  // Find first AUTHENTICATION key with HIGH or CRITICAL security level
  const authKey = state.identityKeys.find(
    (k) => k.purpose === 'AUTHENTICATION' && (k.securityLevel === 'HIGH' || k.securityLevel === 'CRITICAL'),
  );
  return {
    ...state,
    step: 'contract_enter_contract',
    mode: 'contract',
    fromManageMenu: undefined,
    contractIdentitySource: 'new',
    contractFromIdentityCreation: true,
    contractPrivateKeyWif: authKey?.privateKeyWif,
    contractPublicKeyId: authKey?.id,
  };
}

/**
 * Start contract bridge flow for new identity route (from review step).
 * Generates mnemonic and identity keys, sets up for deposit.
 */
export function setContractStartBridge(state: BridgeState): BridgeState {
  const mnemonic = generateNewMnemonic(128);
  return {
    ...state,
    mode: 'create' as BridgeMode,
    fromManageMenu: undefined,
    step: 'configure_keys',
    mnemonic,
    identityKeys: generateDefaultIdentityKeysHD(state.network, mnemonic),
    contractFromIdentityCreation: true,
  };
}

// ============================================================================
// Faucet State Functions
// ============================================================================

/**
 * Set faucet status to solving proof of work
 */
export function setFaucetSolvingPow(state: BridgeState): BridgeState {
  return {
    ...state,
    faucetRequestStatus: 'solving_pow',
    faucetError: undefined,
  };
}

/**
 * Set faucet status to requesting funds
 */
export function setFaucetRequesting(state: BridgeState): BridgeState {
  return {
    ...state,
    faucetRequestStatus: 'requesting',
    faucetError: undefined,
  };
}

/**
 * Set faucet request success with txid
 */
export function setFaucetSuccess(state: BridgeState, txid: string): BridgeState {
  return {
    ...state,
    faucetRequestStatus: 'success',
    faucetTxid: txid,
    faucetError: undefined,
  };
}

/**
 * Set faucet request error
 */
export function setFaucetError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    faucetRequestStatus: 'error',
    faucetError: error,
  };
}

/**
 * Reset faucet state to idle
 */
export function resetFaucetState(state: BridgeState): BridgeState {
  return {
    ...state,
    faucetRequestStatus: 'idle',
    faucetTxid: undefined,
    faucetError: undefined,
  };
}

// ============================================================================
// Withdraw (Asset Unlock) State Functions
// ============================================================================

/**
 * Start fetching identity keys + balance for withdrawal
 */
export function setWithdrawIdentityFetching(state: BridgeState, identityId: string): BridgeState {
  return {
    ...state,
    targetIdentityId: identityId,
    withdrawIdentityFetching: true,
    withdrawIdentityFetchError: undefined,
    withdrawIdentityKeys: undefined,
    withdrawBalance: undefined,
    withdrawSigningKeyInfo: undefined,
    withdrawKeyValidationError: undefined,
  };
}

/**
 * Identity fetch succeeded — advance to configure step with keys + balance
 */
export function setWithdrawIdentityFetched(
  state: BridgeState,
  keys: IdentityPublicKeyInfo[],
  balanceCredits: bigint
): BridgeState {
  return {
    ...state,
    step: 'withdraw_configure',
    withdrawIdentityFetching: false,
    withdrawIdentityFetchError: undefined,
    withdrawIdentityKeys: keys,
    withdrawBalance: balanceCredits,
  };
}

/**
 * Identity fetch failed
 */
export function setWithdrawIdentityFetchError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    withdrawIdentityFetching: false,
    withdrawIdentityFetchError: error,
    withdrawIdentityKeys: undefined,
    withdrawBalance: undefined,
  };
}

/**
 * Signing key validated (matched a TRANSFER key on the identity)
 */
export function setWithdrawKeyValidated(
  state: BridgeState,
  keyId: number,
  purpose: number,
  securityLevel: number,
  privateKeyWif: string
): BridgeState {
  return {
    ...state,
    withdrawPrivateKeyWif: privateKeyWif,
    withdrawSigningKeyInfo: { keyId, purpose, securityLevel },
    withdrawKeyValidationError: undefined,
  };
}

/**
 * Key validation failed
 */
export function setWithdrawKeyValidationError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    withdrawSigningKeyInfo: undefined,
    withdrawPrivateKeyWif: undefined,
    withdrawKeyValidationError: error,
  };
}

/**
 * Clear key validation (when private key input changes)
 */
export function clearWithdrawKeyValidation(state: BridgeState): BridgeState {
  return {
    ...state,
    withdrawSigningKeyInfo: undefined,
    withdrawPrivateKeyWif: undefined,
    withdrawKeyValidationError: undefined,
  };
}

/**
 * Set the destination address input; pass `error` when it failed validation.
 * The raw input is kept either way so the user can correct typos in place.
 */
export function setWithdrawAddress(state: BridgeState, input: string, error?: string): BridgeState {
  return {
    ...state,
    withdrawToAddress: input || undefined,
    withdrawAddressError: error,
  };
}

/**
 * Set validated withdrawal amount (in credits)
 */
export function setWithdrawAmount(state: BridgeState, credits: bigint, input: string): BridgeState {
  return {
    ...state,
    withdrawAmountCredits: credits,
    withdrawAmountInput: input,
    withdrawAmountError: undefined,
  };
}

/**
 * Amount validation failed (keeps the raw input for correction)
 */
export function setWithdrawAmountError(state: BridgeState, input: string, error: string): BridgeState {
  return {
    ...state,
    withdrawAmountCredits: undefined,
    withdrawAmountInput: input,
    withdrawAmountError: error,
  };
}

/**
 * Start submitting the withdrawal transition
 */
export function setWithdrawSubmitting(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'withdraw_submitting',
    withdrawResult: undefined,
    withdrawStatus: undefined,
    withdrawStatusError: undefined,
  };
}

/**
 * Withdrawal transition accepted (or its outcome is unknown after a submission
 * timeout) — start tracking payout status. `remainingBalance` is undefined in
 * the timed-out case, where the post-withdrawal balance was never observed.
 */
export function setWithdrawSubmitted(state: BridgeState, remainingBalance?: bigint): BridgeState {
  return {
    ...state,
    step: 'withdraw_tracking',
    withdrawResult: { success: true, remainingBalance },
    withdrawStatus: WithdrawalStatus.QUEUED,
  };
}

/**
 * Withdrawal transition failed
 */
export function setWithdrawSubmitError(state: BridgeState, error: string): BridgeState {
  return {
    ...state,
    step: 'withdraw_complete',
    withdrawResult: { success: false, error },
  };
}

/**
 * Update tracked withdrawal status; terminal statuses finish the flow.
 * A successful status read also clears any transient polling warning.
 */
export function setWithdrawStatusUpdate(state: BridgeState, status: number): BridgeState {
  const isTerminal = status === WithdrawalStatus.COMPLETE || status === WithdrawalStatus.EXPIRED;
  return {
    ...state,
    step: isTerminal ? 'withdraw_complete' : state.step,
    withdrawStatus: status,
    withdrawStatusError: undefined,
  };
}

/**
 * Set or clear the transient status-polling note shown on the tracking step
 */
export function setWithdrawStatusNote(state: BridgeState, note?: string): BridgeState {
  return {
    ...state,
    withdrawStatusError: note,
  };
}

/**
 * Stop tracking without a terminal status (timeout or user chose to leave).
 * The withdrawal itself succeeded — this only annotates why tracking stopped.
 */
export function setWithdrawTrackingTimeout(state: BridgeState, explanation: string): BridgeState {
  return {
    ...state,
    step: 'withdraw_complete',
    withdrawStatusError: explanation,
  };
}

/**
 * Go back to withdraw identity entry, clearing key material
 */
export function setWithdrawBackToEntry(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'withdraw_enter_identity',
    withdrawSigningKeyInfo: undefined,
    withdrawPrivateKeyWif: undefined,
    withdrawKeyValidationError: undefined,
    withdrawAmountCredits: undefined,
    withdrawAmountInput: undefined,
    withdrawAmountError: undefined,
    withdrawToAddress: undefined,
    withdrawAddressError: undefined,
  };
}

/**
 * Return to configure step to retry a failed withdrawal
 */
export function setWithdrawRetry(state: BridgeState): BridgeState {
  return {
    ...state,
    step: 'withdraw_configure',
    withdrawResult: undefined,
    withdrawStatus: undefined,
    withdrawStatusError: undefined,
  };
}

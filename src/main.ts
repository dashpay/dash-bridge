import { getNetwork, MAINNET, TESTNET } from './config.js';
import { publicKeyToAddress, signTransaction, generateKeyPair } from './crypto/index.js';
import { deriveAssetLockKeyPair } from './crypto/hd.js';
import { createAssetLockTransaction, serializeTransaction } from './transaction/index.js';
import { InsightClient } from './api/insight.js';
import { DAPIClient } from './api/dapi.js';
import { buildInstantAssetLockProof } from './proof/index.js';
import { registerIdentity, topUpIdentity, updateIdentity, sendToPlatformAddress, AddKeyConfig } from './platform/index.js';
import { bech32m } from '@scure/base';
import { privateKeyToWif, bytesToHex } from './utils/index.js';
import {
  createInitialState,
  setStep,
  setKeyPairs,
  setMode,
  setTargetIdentityId,
  setOneTimeKeyPair,
  setTopUpComplete,
  setRecipientPlatformAddress,
  setSendToAddressComplete,
  setUtxoDetected,
  setTransactionSigned,
  setTransactionBroadcast,
  setInstantLockReceived,
  setIdentityRegistered,
  setError,
  toError,
  ErrorCodes,
  setDepositTimedOut,
  setNetwork,
  updateIdentityKey,
  addIdentityKey,
  removeIdentityKey,
  render,
  downloadKeyBackup,
  // DPNS state functions
  setModeDpnsFromIdentity,
  setDpnsIdentitySource,
  setDpnsExistingIdentity,
  addDpnsUsername,
  updateDpnsUsername,
  removeDpnsUsername,
  setDpnsChecking,
  setDpnsAvailability,
  acknowledgeDpnsContestedWarning,
  setDpnsRegistering,
  setDpnsRegistrationProgress,
  setDpnsResults,
  resetDpnsForMore,
  setDpnsBackToEntry,
  // New DPNS identity validation functions
  setDpnsIdentityFetching,
  setDpnsIdentityFetched,
  setDpnsIdentityFetchError,
  setDpnsKeyValidated,
  setDpnsKeyValidationError,
  clearDpnsKeyValidation,
  // Identity Management state functions
  setManageIdentityFetching,
  setManageIdentityFetched,
  setManageIdentityFetchError,
  setManageKeyValidated,
  setManageKeyValidationError,
  clearManageKeyValidation,
  addManageNewKey,
  removeManageNewKey,
  updateManageNewKey,
  toggleManageDisableKey,
  setManageUpdating,
  setManageComplete,
  resetManageState,
  resetManageStateAndRefresh,
  setManageBackToEntry,
  // Contract registration state functions
  setContractIdentitySource,
  setContractIdentityFetching,
  setContractIdentityFetched,
  setContractIdentityFetchError,
  setContractKeyValidated,
  setContractKeyValidationError,
  setContractJson,
  setContractReview,
  setContractRegistering,
  setContractComplete,
  setModeContractFromIdentity,
  setContractStartBridge,
  // Faucet state functions
  setFaucetSolvingPow,
  setFaucetRequesting,
  setFaucetSuccess,
  setFaucetError,
} from './ui/index.js';
import {
  getFaucetStatus,
  solveCap,
  requestTestnetFunds,
} from './api/faucet.js';
import {
  checkMultipleAvailability,
  registerMultipleNames,
  getIdentityPublicKeys,
} from './platform/dpns.js';
import {
  findMatchingKeyIndex,
  isSecurityLevelAllowedForDpns,
  isPurposeAllowedForDpns,
  getSecurityLevelName,
  getPurposeName,
  generateIdentityKey,
} from './crypto/keys.js';
import { publishContract, extractDocumentSchemas } from './platform/contract.js';
import { estimateContractFee, parseContractJson } from 'dash-contract-fee-estimator';
import type { KeyType, KeyPurpose, SecurityLevel, ManageNewKeyConfig } from './types.js';
import type { BridgeState } from './types.js';

// Global state
let state: BridgeState;
let insightClient: InsightClient;
let dapiClient: DAPIClient;

/**
 * Initialize the application
 */
function init() {
  const urlParams = new URLSearchParams(window.location.search);

  // Infer network from ?address= param prefix, falling back to ?network= param
  let network: 'testnet' | 'mainnet' = urlParams.get('network') === 'mainnet' ? 'mainnet' : 'testnet';
  const addressParam = urlParams.get('address')?.trim();
  if (addressParam) {
    try {
      const decoded = bech32m.decode(addressParam as `${string}1${string}`);
      if (decoded.prefix === MAINNET.platformHrp) network = 'mainnet';
      else if (decoded.prefix === TESTNET.platformHrp) network = 'testnet';
    } catch {
      // Invalid address — will be ignored below
    }
  }

  // Initialize state
  state = createInitialState(network);
  insightClient = new InsightClient(getNetwork(network));
  dapiClient = new DAPIClient({ network });

  // Deep-link: ?address=<bech32m> opens send-to-address mode with address pre-filled
  if (addressParam && validatePlatformAddress(addressParam, network)) {
    state = setMode(state, 'send_to_address');
    state = setRecipientPlatformAddress(state, addressParam);
  }

  // Deep-link: ?mode=contract opens contract registration mode
  const modeParam = urlParams.get('mode');
  if (modeParam === 'contract') {
    state = setMode(state, 'contract');
    const contractParam = urlParams.get('contract');
    if (contractParam) {
      try {
        const jsonStr = atob(contractParam.replace(/-/g, '+').replace(/_/g, '/'));
        const json = JSON.parse(jsonStr);
        const parsed = parseContractJson(json);
        const estimate = estimateContractFee(parsed);
        state = setContractJson(state, JSON.stringify(json, null, 2), parsed, estimate, undefined);
      } catch {
        // Invalid contract param, ignore
      }
    }
  }

  // Render UI
  const container = document.getElementById('app');
  if (container) {
    render(state, container);
    setupEventListeners(container);
  }
}

/**
 * Update state and re-render
 */
function updateState(newState: BridgeState) {
  state = newState;
  const container = document.getElementById('app');
  if (container) {
    // Save focus state before re-render
    const activeElement = document.activeElement as HTMLInputElement | null;
    const focusInfo = activeElement ? {
      id: activeElement.id,
      className: activeElement.className,
      dataIndex: activeElement.dataset?.index,
      selectionStart: activeElement.selectionStart,
      selectionEnd: activeElement.selectionEnd,
    } : null;

    render(state, container);
    setupEventListeners(container);

    // Restore focus after re-render
    if (focusInfo) {
      let elementToFocus: HTMLInputElement | null = null;

      // Try to find by ID first
      if (focusInfo.id) {
        elementToFocus = document.getElementById(focusInfo.id) as HTMLInputElement;
      }

      // For DPNS username inputs, find by data-index
      if (!elementToFocus && focusInfo.className?.includes('dpns-username-input') && focusInfo.dataIndex !== undefined) {
        elementToFocus = container.querySelector(
          `.dpns-username-input[data-index="${focusInfo.dataIndex}"]`
        ) as HTMLInputElement;
      }

      if (elementToFocus) {
        elementToFocus.focus();
        // Restore cursor position (only for text-like inputs)
        if (
          focusInfo.selectionStart !== null &&
          focusInfo.selectionEnd !== null &&
          typeof elementToFocus.setSelectionRange === 'function'
        ) {
          elementToFocus.setSelectionRange(focusInfo.selectionStart, focusInfo.selectionEnd);
        }
      }
    }
  }
}

/**
 * Setup event listeners
 */
function setupEventListeners(container: HTMLElement) {
  // Network selector buttons
  container.querySelectorAll('.network-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const network = (btn as HTMLElement).dataset.network as 'testnet' | 'mainnet';
      if (network && network !== state.network) {
        // Update state and reinitialize clients for new network
        updateState(setNetwork(state, network));
        insightClient = new InsightClient(getNetwork(network));
        dapiClient = new DAPIClient({ network });
      }
    });
  });

  // Mode selection buttons (init page)
  const modeCreateBtn = container.querySelector('#mode-create-btn');
  if (modeCreateBtn) {
    modeCreateBtn.addEventListener('click', () => {
      updateState(setMode(state, 'create'));
    });
  }

  const modeTopUpBtn = container.querySelector('#mode-topup-btn');
  if (modeTopUpBtn) {
    modeTopUpBtn.addEventListener('click', () => {
      updateState(setMode(state, 'topup'));
    });
  }

  // Platform Address mode button (init page)
  const modeSendToAddressBtn = container.querySelector('#mode-send-to-address-btn');
  if (modeSendToAddressBtn) {
    modeSendToAddressBtn.addEventListener('click', () => {
      updateState(setMode(state, 'send_to_address'));
    });
  }

  // Back button (configure keys, enter identity, enter recipient address -> init)
  const backBtn = container.querySelector('#back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (state.contractFromIdentityCreation) {
        // Return to contract review instead of init
        updateState({ ...state, mode: 'contract', step: 'contract_review' });
      } else {
        updateState(setStep(state, 'init'));
      }
    });
  }

  // Identity ID input (for top-up mode)
  const identityInput = container.querySelector('#identity-id-input') as HTMLInputElement;
  if (identityInput) {
    identityInput.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value.trim();
      updateState(setTargetIdentityId(state, value));
    });
  }

  // Continue top-up button
  const continueTopUpBtn = container.querySelector('#continue-topup-btn');
  if (continueTopUpBtn) {
    continueTopUpBtn.addEventListener('click', () => {
      if (validateIdentityId(state.targetIdentityId)) {
        startTopUp();
      } else {
        showValidationError('Please enter a valid identity ID (44 character Base58 string)');
      }
    });
  }

  // Recipient platform address input (send_to_address mode)
  const recipientAddressInput = container.querySelector('#recipient-address-input');
  if (recipientAddressInput) {
    recipientAddressInput.addEventListener('input', (e) => {
      const value = (e.target as HTMLInputElement).value.trim();
      updateState(setRecipientPlatformAddress(state, value));
    });
  }

  // Continue send to address button
  const continueSendToAddressBtn = container.querySelector('#continue-send-to-address-btn');
  if (continueSendToAddressBtn) {
    continueSendToAddressBtn.addEventListener('click', () => {
      const address = state.recipientPlatformAddress;
      if (address && validatePlatformAddress(address, state.network)) {
        startSendToAddress();
      } else {
        const prefix = `${getNetwork(state.network).platformHrp}1`;
        const msg = document.getElementById('recipient-address-validation-msg');
        if (msg) {
          msg.textContent = `Please enter a valid bech32m platform address (starts with ${prefix})`;
          msg.classList.remove('hidden');
        }
      }
    });
  }

  // Continue button (configure keys -> start bridge)
  const continueBtn = container.querySelector('#continue-btn');
  if (continueBtn) {
    continueBtn.addEventListener('click', startBridge);
  }

  // Recheck deposit button
  const recheckBtn = container.querySelector('#recheck-deposit-btn');
  if (recheckBtn) {
    recheckBtn.addEventListener('click', recheckDeposit);
  }

  // Faucet request button (testnet only)
  const faucetBtn = container.querySelector('#request-faucet-btn');
  if (faucetBtn) {
    faucetBtn.addEventListener('click', requestFaucetFunds);
  }

  // Deposit method toggle (testnet collapsible section)
  const depositToggle = container.querySelector('.deposit-method-toggle');
  if (depositToggle) {
    depositToggle.addEventListener('click', () => {
      const content = container.querySelector('.deposit-method-content');
      const isExpanded = depositToggle.getAttribute('aria-expanded') === 'true';
      depositToggle.setAttribute('aria-expanded', String(!isExpanded));
      content?.classList.toggle('collapsed');
      depositToggle.classList.toggle('expanded');
    });
  }

  // Copy buttons
  container.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = (btn as HTMLElement).dataset.copy || '';
      navigator.clipboard.writeText(text);
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 2000);
    });
  });

  // Download keys button
  const downloadBtn = container.querySelector('#download-keys-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      downloadKeyBackup(state);
    });
  }

  // Retry button
  const retryBtn = container.querySelector('#retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      updateState(createInitialState(state.network));
    });
  }

  // Add key button
  const addKeyBtn = container.querySelector('#add-key-btn');
  if (addKeyBtn) {
    addKeyBtn.addEventListener('click', () => {
      updateState(addIdentityKey(state));
    });
  }

  // Remove key buttons
  container.querySelectorAll('.remove-key-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const keyId = parseInt((btn as HTMLElement).dataset.keyId || '0', 10);
      updateState(removeIdentityKey(state, keyId));
    });
  });

  // Key type selects
  container.querySelectorAll('.key-type-select').forEach((select) => {
    select.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      const keyId = parseInt(target.dataset.keyId || '0', 10);
      updateState(updateIdentityKey(state, keyId, { keyType: target.value as KeyType }));
    });
  });

  // Key purpose selects
  container.querySelectorAll('.key-purpose-select').forEach((select) => {
    select.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      const keyId = parseInt(target.dataset.keyId || '0', 10);
      updateState(updateIdentityKey(state, keyId, { purpose: target.value as KeyPurpose }));
    });
  });

  // Key security level selects
  container.querySelectorAll('.key-security-select').forEach((select) => {
    select.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      const keyId = parseInt(target.dataset.keyId || '0', 10);
      updateState(updateIdentityKey(state, keyId, { securityLevel: target.value as SecurityLevel }));
    });
  });

  // ============================================================================
  // DPNS Event Listeners
  // ============================================================================

  // DPNS mode button (init page)
  const modeDpnsBtn = container.querySelector('#mode-dpns-btn');
  if (modeDpnsBtn) {
    modeDpnsBtn.addEventListener('click', () => {
      updateState(setMode(state, 'dpns'));
    });
  }

  // DPNS from identity complete button
  const dpnsFromIdentityBtn = container.querySelector('#dpns-from-identity-btn');
  if (dpnsFromIdentityBtn) {
    dpnsFromIdentityBtn.addEventListener('click', () => {
      // Find a key with AUTHENTICATION purpose and CRITICAL or HIGH security level
      // Priority: CRITICAL > HIGH (keys 2 and 1 in default setup)
      const validKey = state.identityKeys.find(k =>
        k.purpose === 'AUTHENTICATION' &&
        (k.securityLevel === 'CRITICAL' || k.securityLevel === 'HIGH')
      );

      if (validKey) {
        const newState = setModeDpnsFromIdentity(state);
        updateState({
          ...newState,
          dpnsPrivateKeyWif: validKey.privateKeyWif,
          dpnsPublicKeyId: validKey.id,
        });
      } else {
        updateState(setError(
          state,
          new Error('No valid key for DPNS registration. You need an AUTHENTICATION key with CRITICAL or HIGH security level.'),
          ErrorCodes.CONFIG
        ));
      }
    });
  }

  // DPNS choose new identity button
  const dpnsChooseNewBtn = container.querySelector('#dpns-choose-new-btn');
  if (dpnsChooseNewBtn) {
    dpnsChooseNewBtn.addEventListener('click', () => {
      updateState(setDpnsIdentitySource(state, 'new'));
    });
  }

  // DPNS choose existing identity button
  const dpnsChooseExistingBtn = container.querySelector('#dpns-choose-existing-btn');
  if (dpnsChooseExistingBtn) {
    dpnsChooseExistingBtn.addEventListener('click', () => {
      updateState(setDpnsIdentitySource(state, 'existing'));
    });
  }

  // DPNS back button (various steps)
  const dpnsBackBtn = container.querySelector('#dpns-back-btn');
  if (dpnsBackBtn) {
    dpnsBackBtn.addEventListener('click', () => {
      // Navigate back based on current step
      switch (state.step) {
        case 'dpns_enter_identity':
          updateState(setStep(state, 'dpns_choose_identity'));
          break;
        case 'dpns_enter_usernames':
          if (state.dpnsFromIdentityCreation) {
            // Go back to complete screen
            updateState(setStep(state, 'complete'));
          } else if (state.dpnsIdentitySource === 'existing') {
            updateState(setStep(state, 'dpns_enter_identity'));
          } else {
            updateState(setStep(state, 'dpns_choose_identity'));
          }
          break;
        case 'dpns_review':
          updateState(setDpnsBackToEntry(state));
          break;
        default:
          updateState(setStep(state, 'init'));
      }
    });
  }

  // DPNS identity ID input - fetch on blur or paste
  const dpnsIdentityIdInput = container.querySelector('#dpns-identity-id-input');
  if (dpnsIdentityIdInput) {
    const fetchIdentity = async () => {
      const input = dpnsIdentityIdInput as HTMLInputElement;
      const identityId = input.value.trim();

      // Skip if empty or same as already fetched
      if (!identityId) {
        return;
      }

      // Skip if already fetching or already fetched this identity
      if (state.dpnsIdentityFetching || (state.targetIdentityId === identityId && state.dpnsIdentityKeys)) {
        return;
      }

      if (!validateIdentityId(identityId)) {
        updateState(setDpnsIdentityFetchError(state, 'Invalid identity ID format (expected 44 character Base58 string)'));
        return;
      }

      // Start fetching
      updateState(setDpnsIdentityFetching(state, identityId));

      try {
        const keys = await getIdentityPublicKeys(identityId, state.network);
        updateState(setDpnsIdentityFetched(state, keys));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to fetch identity';
        updateState(setDpnsIdentityFetchError(state, message));
      }
    };

    dpnsIdentityIdInput.addEventListener('blur', fetchIdentity);
    dpnsIdentityIdInput.addEventListener('paste', () => {
      setTimeout(fetchIdentity, 50);
    });
  }

  // DPNS private key input - validate on blur or paste (waits for identity fetch if needed)
  const dpnsPrivateKeyInput = container.querySelector('#dpns-private-key-input');
  if (dpnsPrivateKeyInput) {
    const validatePrivateKey = async () => {
      const input = dpnsPrivateKeyInput as HTMLInputElement;
      const privateKeyWif = input.value.trim();

      // Clear previous validation if empty
      if (!privateKeyWif) {
        updateState(clearDpnsKeyValidation(state));
        return;
      }

      // Wait for identity fetch to complete if in progress
      const waitForIdentity = (): Promise<void> => {
        return new Promise((resolve) => {
          const check = () => {
            if (!state.dpnsIdentityFetching) {
              resolve();
            } else {
              setTimeout(check, 100);
            }
          };
          check();
        });
      };

      if (state.dpnsIdentityFetching) {
        await waitForIdentity();
      }

      // Check if identity was fetched successfully
      if (!state.dpnsIdentityKeys || state.dpnsIdentityKeys.length === 0) {
        if (state.dpnsIdentityFetchError) {
          // Identity fetch failed, don't validate key yet
          return;
        }
        updateState(setDpnsKeyValidationError(state, 'Please enter an identity ID first'));
        return;
      }

      // Find matching key
      const match = findMatchingKeyIndex(privateKeyWif, state.dpnsIdentityKeys, state.network);

      if (!match) {
        updateState(setDpnsKeyValidationError(state, 'This key does not match any key registered with this identity'));
        return;
      }

      // Check purpose (must be AUTHENTICATION)
      if (!isPurposeAllowedForDpns(match.purpose)) {
        const purposeName = getPurposeName(match.purpose);
        updateState(setDpnsKeyValidationError(
          state,
          `This key has ${purposeName} purpose. Please use an AUTHENTICATION key for DPNS registration.`
        ));
        return;
      }

      // Check security level (must be CRITICAL or HIGH)
      if (!isSecurityLevelAllowedForDpns(match.securityLevel)) {
        const levelName = getSecurityLevelName(match.securityLevel);
        updateState(setDpnsKeyValidationError(
          state,
          `This key has ${levelName} security level. Please use a CRITICAL or HIGH level key for DPNS registration.`
        ));
        return;
      }

      // Key is valid
      updateState(setDpnsKeyValidated(state, match.keyId, privateKeyWif));
    };

    dpnsPrivateKeyInput.addEventListener('blur', validatePrivateKey);
    dpnsPrivateKeyInput.addEventListener('paste', () => {
      // Small delay to let the paste complete before validating
      setTimeout(validatePrivateKey, 50);
    });
  }

  // DPNS identity continue button (only enabled when key is validated)
  const dpnsIdentityContinueBtn = container.querySelector('#dpns-identity-continue-btn');
  if (dpnsIdentityContinueBtn) {
    dpnsIdentityContinueBtn.addEventListener('click', () => {
      // Validation already done, just proceed if we have validated key
      if (state.dpnsValidatedKeyId !== undefined && state.targetIdentityId && state.dpnsPrivateKeyWif) {
        updateState(setDpnsExistingIdentity(
          state,
          state.targetIdentityId,
          state.dpnsPrivateKeyWif,
          state.dpnsValidatedKeyId
        ));
      }
    });
  }

  // DPNS username inputs
  container.querySelectorAll('.dpns-username-input').forEach((input) => {
    input.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || '0', 10);
      updateState(updateDpnsUsername(state, index, target.value));
    });
  });

  // DPNS add username button
  const addDpnsUsernameBtn = container.querySelector('#add-dpns-username-btn');
  if (addDpnsUsernameBtn) {
    addDpnsUsernameBtn.addEventListener('click', () => {
      updateState(addDpnsUsername(state));
    });
  }

  // DPNS remove username buttons
  container.querySelectorAll('.remove-dpns-username-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = parseInt((btn as HTMLElement).dataset.index || '0', 10);
      updateState(removeDpnsUsername(state, index));
    });
  });

  // DPNS check availability button
  const checkAvailabilityBtn = container.querySelector('#check-availability-btn');
  if (checkAvailabilityBtn) {
    checkAvailabilityBtn.addEventListener('click', startDpnsCheck);
  }

  // DPNS add non-contested button (in review warning)
  const addNoncontestedBtn = container.querySelector('#add-noncontested-btn');
  if (addNoncontestedBtn) {
    addNoncontestedBtn.addEventListener('click', () => {
      // Go back to username entry to add more
      updateState(setDpnsBackToEntry(addDpnsUsername(state)));
    });
  }

  // DPNS contested warning checkbox
  const dpnsContestedCheckbox = container.querySelector('#dpns-contested-checkbox') as HTMLInputElement;
  if (dpnsContestedCheckbox) {
    dpnsContestedCheckbox.addEventListener('change', () => {
      if (dpnsContestedCheckbox.checked) {
        updateState(acknowledgeDpnsContestedWarning(state));
      }
    });
  }

  // DPNS register button
  const registerDpnsBtn = container.querySelector('#register-dpns-btn');
  if (registerDpnsBtn) {
    registerDpnsBtn.addEventListener('click', startDpnsRegistration);
  }

  // DPNS register more button
  const dpnsRegisterMoreBtn = container.querySelector('#dpns-register-more-btn');
  if (dpnsRegisterMoreBtn) {
    dpnsRegisterMoreBtn.addEventListener('click', () => {
      updateState(resetDpnsForMore(state));
    });
  }

  // ============================================================================
  // Identity Management Event Listeners
  // ============================================================================

  // Manage mode button (init page)
  const modeManageBtn = container.querySelector('#mode-manage-btn');
  if (modeManageBtn) {
    modeManageBtn.addEventListener('click', () => {
      updateState(setMode(state, 'manage'));
    });
  }

  // Manage back button (various steps)
  const manageBackBtn = container.querySelector('#manage-back-btn');
  if (manageBackBtn) {
    manageBackBtn.addEventListener('click', () => {
      switch (state.step) {
        case 'manage_enter_identity':
          updateState(setStep(state, 'init'));
          break;
        case 'manage_view_keys':
          updateState(setManageBackToEntry(state));
          break;
        case 'manage_complete':
          // Go back to init
          updateState(setStep(state, 'init'));
          break;
        default:
          updateState(setStep(state, 'init'));
      }
    });
  }

  // Manage identity ID input - fetch on blur or paste
  const manageIdentityIdInput = container.querySelector('#manage-identity-id-input');
  if (manageIdentityIdInput) {
    const fetchIdentity = async () => {
      const input = manageIdentityIdInput as HTMLInputElement;
      const identityId = input.value.trim();

      // Skip if empty
      if (!identityId) {
        return;
      }

      // Skip if already fetching or already fetched this identity
      if (state.manageIdentityFetching || (state.targetIdentityId === identityId && state.manageIdentityKeys)) {
        return;
      }

      if (!validateIdentityId(identityId)) {
        updateState(setManageIdentityFetchError(state, 'Invalid identity ID format (expected 44 character Base58 string)'));
        return;
      }

      // Start fetching
      updateState(setManageIdentityFetching(state, identityId));

      try {
        const keys = await getIdentityPublicKeys(identityId, state.network);
        updateState(setManageIdentityFetched(state, keys));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to fetch identity';
        updateState(setManageIdentityFetchError(state, message));
      }
    };

    manageIdentityIdInput.addEventListener('blur', fetchIdentity);
    manageIdentityIdInput.addEventListener('paste', () => {
      setTimeout(fetchIdentity, 50);
    });
  }

  // Manage private key input - validate on blur or paste
  const managePrivateKeyInput = container.querySelector('#manage-private-key-input');
  if (managePrivateKeyInput) {
    const validatePrivateKey = async () => {
      const input = managePrivateKeyInput as HTMLInputElement;
      const privateKeyWif = input.value.trim();

      // Clear previous validation if empty
      if (!privateKeyWif) {
        updateState(clearManageKeyValidation(state));
        return;
      }

      // Wait for identity fetch to complete if in progress
      const waitForIdentity = (): Promise<void> => {
        return new Promise((resolve) => {
          const check = () => {
            if (!state.manageIdentityFetching) {
              resolve();
            } else {
              setTimeout(check, 100);
            }
          };
          check();
        });
      };

      if (state.manageIdentityFetching) {
        await waitForIdentity();
      }

      // Check if identity was fetched successfully
      if (!state.manageIdentityKeys || state.manageIdentityKeys.length === 0) {
        if (state.manageIdentityFetchError) {
          return;
        }
        updateState(setManageKeyValidationError(state, 'Please enter an identity ID first'));
        return;
      }

      // Find matching key
      const match = findMatchingKeyIndex(privateKeyWif, state.manageIdentityKeys, state.network);

      if (!match) {
        updateState(setManageKeyValidationError(state, 'This key does not match any key registered with this identity'));
        return;
      }

      // Check security level (must be MASTER=0 for identity updates)
      if (match.securityLevel !== 0) {
        const levelName = getSecurityLevelName(match.securityLevel);
        updateState(setManageKeyValidationError(
          state,
          `This key has ${levelName} security level. Only MASTER level keys can add or disable keys.`
        ));
        return;
      }

      // Key is valid
      updateState(setManageKeyValidated(state, match.keyId, match.securityLevel, privateKeyWif));
    };

    managePrivateKeyInput.addEventListener('blur', validatePrivateKey);
    managePrivateKeyInput.addEventListener('paste', () => {
      setTimeout(validatePrivateKey, 50);
    });
  }

  // Manage identity continue button
  const manageIdentityContinueBtn = container.querySelector('#manage-identity-continue-btn');
  if (manageIdentityContinueBtn) {
    manageIdentityContinueBtn.addEventListener('click', () => {
      // Just proceed if we have validated key - setManageKeyValidated already transitions
      // This button is only enabled when validation is complete
    });
  }

  // Manage add new key button
  const addManageKeyBtn = container.querySelector('#add-manage-key-btn');
  if (addManageKeyBtn) {
    addManageKeyBtn.addEventListener('click', () => {
      const tempId = `new-${Date.now()}`;
      const generated = generateIdentityKey(
        0, // temporary id
        'New Key',
        'ECDSA_SECP256K1',
        'AUTHENTICATION',
        'HIGH',
        state.network
      );

      const newKeyConfig: ManageNewKeyConfig = {
        tempId,
        keyType: 'ECDSA_SECP256K1',
        purpose: 'AUTHENTICATION',
        securityLevel: 'HIGH',
        source: 'generate',
        generatedKey: {
          privateKey: generated.privateKey,
          publicKey: generated.publicKey,
          privateKeyHex: generated.privateKeyHex,
          privateKeyWif: generated.privateKeyWif,
          publicKeyHex: generated.publicKeyHex,
        },
      };

      updateState(addManageNewKey(state, newKeyConfig));
    });
  }

  // Manage remove new key buttons
  container.querySelectorAll('.remove-manage-new-key-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tempId = (btn as HTMLElement).dataset.tempId;
      if (tempId) {
        updateState(removeManageNewKey(state, tempId));
      }
    });
  });

  // Manage disable key checkboxes
  container.querySelectorAll('.manage-disable-key-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const keyId = parseInt((checkbox as HTMLElement).dataset.keyId || '0', 10);
      updateState(toggleManageDisableKey(state, keyId));
    });
  });

  // Manage key type selects
  container.querySelectorAll('.manage-key-type-select').forEach((select) => {
    select.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      const tempId = target.dataset.tempId;
      if (tempId) {
        // Regenerate key when type changes
        const newType = target.value as KeyType;
        const existingKey = state.manageKeysToAdd?.find(k => k.tempId === tempId);
        if (existingKey) {
          const generated = generateIdentityKey(
            0,
            'New Key',
            newType,
            existingKey.purpose,
            existingKey.securityLevel,
            state.network
          );
          updateState(updateManageNewKey(state, tempId, {
            keyType: newType,
            generatedKey: {
              privateKey: generated.privateKey,
              publicKey: generated.publicKey,
              privateKeyHex: generated.privateKeyHex,
              privateKeyWif: generated.privateKeyWif,
              publicKeyHex: generated.publicKeyHex,
            },
          }));
        }
      }
    });
  });

  // Manage key purpose selects
  container.querySelectorAll('.manage-key-purpose-select').forEach((select) => {
    select.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      const tempId = target.dataset.tempId;
      if (tempId) {
        updateState(updateManageNewKey(state, tempId, { purpose: target.value as KeyPurpose }));
      }
    });
  });

  // Manage key security level selects
  container.querySelectorAll('.manage-key-security-select').forEach((select) => {
    select.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      const tempId = target.dataset.tempId;
      if (tempId) {
        updateState(updateManageNewKey(state, tempId, { securityLevel: target.value as SecurityLevel }));
      }
    });
  });

  // Apply manage changes button
  const applyManageBtn = container.querySelector('#apply-manage-btn');
  if (applyManageBtn) {
    applyManageBtn.addEventListener('click', startManageUpdate);
  }

  // Manage more changes button - refetch keys to show updated state
  const manageMoreBtn = container.querySelector('#manage-more-btn');
  if (manageMoreBtn) {
    manageMoreBtn.addEventListener('click', async () => {
      // Capture the intermediate state to use after async operation
      const refreshedState = resetManageStateAndRefresh(state);
      updateState(refreshedState);

      // Refetch identity keys from the network
      const targetId = refreshedState.targetIdentityId;
      if (targetId) {
        try {
          const keys = await getIdentityPublicKeys(targetId, refreshedState.network);
          updateState(setManageIdentityFetched(refreshedState, keys));
        } catch (error) {
          // If refetch fails, show error in UI
          console.error('Failed to refetch identity keys:', error);
          const errorMsg = error instanceof Error ? error.message : 'Failed to refresh keys';
          updateState(setManageIdentityFetchError(refreshedState, errorMsg));
        }
      }
    });
  }

  // Manage retry button
  const manageRetryBtn = container.querySelector('#manage-retry-btn');
  if (manageRetryBtn) {
    manageRetryBtn.addEventListener('click', () => {
      updateState(resetManageState(state));
    });
  }

  // ============================================================================
  // Contract Registration Event Listeners
  // ============================================================================

  // Contract mode button (init page)
  const modeContractBtn = container.querySelector('#mode-contract-btn');
  if (modeContractBtn) {
    modeContractBtn.addEventListener('click', () => {
      updateState(setMode(state, 'contract'));
    });
  }

  // Contract choose identity buttons
  const contractChooseNewBtn = container.querySelector('#contract-choose-new-btn');
  if (contractChooseNewBtn) {
    contractChooseNewBtn.addEventListener('click', () => {
      updateState(setContractIdentitySource(state, 'new'));
    });
  }

  const contractChooseExistingBtn = container.querySelector('#contract-choose-existing-btn');
  if (contractChooseExistingBtn) {
    contractChooseExistingBtn.addEventListener('click', () => {
      updateState(setContractIdentitySource(state, 'existing'));
    });
  }

  // Contract from identity creation complete
  const contractFromIdentityBtn = container.querySelector('#contract-from-identity-btn');
  if (contractFromIdentityBtn) {
    contractFromIdentityBtn.addEventListener('click', () => {
      updateState(setModeContractFromIdentity(state));
    });
  }

  // Contract identity ID input (existing identity route)
  const contractIdentityIdInput = container.querySelector<HTMLInputElement>('#contract-identity-id-input');
  if (contractIdentityIdInput) {
    const fetchContractIdentity = async () => {
      const identityId = contractIdentityIdInput.value.trim();
      if (!validateIdentityId(identityId)) return;

      updateState(setContractIdentityFetching(state, identityId));

      try {
        const keys = await getIdentityPublicKeys(identityId, state.network);
        // Also fetch balance for the existing identity credit check
        let balance: number | undefined;
        try {
          const { EvoSDK } = await import('@dashevo/evo-sdk');
          const sdk = state.network === 'mainnet' ? EvoSDK.mainnetTrusted() : EvoSDK.testnetTrusted();
          await sdk.connect();
          const result = await sdk.identities.balanceAndRevision(identityId);
          balance = Number(result?.balance ?? 0n);
        } catch {
          // Balance fetch is best-effort; continue without it
        }
        updateState(setContractIdentityFetched(state, keys, balance));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        updateState(setContractIdentityFetchError(state, msg));
      }
    };

    contractIdentityIdInput.addEventListener('blur', fetchContractIdentity);
    contractIdentityIdInput.addEventListener('paste', () => setTimeout(fetchContractIdentity, 50));
  }

  // Contract private key input (existing identity route)
  const contractPrivateKeyInput = container.querySelector<HTMLInputElement>('#contract-private-key-input');
  if (contractPrivateKeyInput) {
    const validateContractPrivateKey = async () => {
      const privateKeyWif = contractPrivateKeyInput.value.trim();
      if (!privateKeyWif || !state.contractIdentityKeys) return;

      try {
        const match = findMatchingKeyIndex(privateKeyWif, state.contractIdentityKeys, state.network);
        if (!match) {
          updateState(setContractKeyValidationError(state, 'Key does not match any identity key'));
          return;
        }
        // Must be AUTHENTICATION with HIGH or CRITICAL
        if (!isPurposeAllowedForDpns(match.purpose)) {
          updateState(setContractKeyValidationError(state, `Key purpose must be AUTHENTICATION, got ${getPurposeName(match.purpose)}`));
          return;
        }
        if (!isSecurityLevelAllowedForDpns(match.securityLevel)) {
          updateState(setContractKeyValidationError(state, `Security level must be HIGH or CRITICAL, got ${getSecurityLevelName(match.securityLevel)}`));
          return;
        }
        updateState(setContractKeyValidated(state, match.keyId, privateKeyWif));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        updateState(setContractKeyValidationError(state, msg));
      }
    };

    contractPrivateKeyInput.addEventListener('blur', validateContractPrivateKey);
    contractPrivateKeyInput.addEventListener('paste', () => setTimeout(validateContractPrivateKey, 50));
  }

  // Contract identity continue button
  const contractIdentityContinueBtn = container.querySelector('#contract-identity-continue-btn');
  if (contractIdentityContinueBtn) {
    contractIdentityContinueBtn.addEventListener('click', () => {
      updateState({ ...state, step: 'contract_enter_contract' });
    });
  }

  // Contract JSON textarea (debounced live parse)
  const contractJsonInput = container.querySelector<HTMLTextAreaElement>('#contract-json-input');
  if (contractJsonInput) {
    let contractDebounceTimer: ReturnType<typeof setTimeout>;
    contractJsonInput.addEventListener('input', () => {
      clearTimeout(contractDebounceTimer);
      contractDebounceTimer = setTimeout(() => {
        const raw = contractJsonInput.value.trim();
        if (!raw) {
          updateState(setContractJson(state, '', undefined, undefined, undefined));
          return;
        }
        try {
          const json = JSON.parse(raw);
          const parsed = parseContractJson(json);
          const estimate = estimateContractFee(parsed);
          updateState(setContractJson(state, raw, parsed, estimate, undefined));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          updateState(setContractJson(state, raw, undefined, undefined, msg));
        }
      }, 300);
    });
  }

  // Contract copy deep link button
  const contractCopyLinkBtn = container.querySelector('#contract-copy-link-btn');
  if (contractCopyLinkBtn) {
    contractCopyLinkBtn.addEventListener('click', () => {
      if (!state.contractJson) return;
      try {
        // Minify the JSON and base64url encode it
        const minified = JSON.stringify(JSON.parse(state.contractJson));
        const base64 = btoa(minified).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const url = new URL(window.location.href);
        url.search = '';
        url.searchParams.set('network', state.network);
        url.searchParams.set('mode', 'contract');
        url.searchParams.set('contract', base64);
        navigator.clipboard.writeText(url.toString()).then(() => {
          const status = document.getElementById('contract-link-status');
          if (status) {
            status.textContent = 'Copied!';
            setTimeout(() => { status.textContent = ''; }, 2000);
          }
        });
      } catch {
        // Clipboard write failed silently
      }
    });
  }

  // Contract review button
  const contractReviewBtn = container.querySelector('#contract-review-btn');
  if (contractReviewBtn) {
    contractReviewBtn.addEventListener('click', () => {
      updateState(setContractReview(state));
    });
  }

  // Contract start bridge button (new identity route: from review → create mode)
  const contractStartBridgeBtn = container.querySelector('#contract-start-bridge-btn');
  if (contractStartBridgeBtn) {
    contractStartBridgeBtn.addEventListener('click', () => {
      updateState(setContractStartBridge(state));
    });
  }

  // Contract publish button (existing identity or post-identity-creation)
  const contractPublishBtn = container.querySelector('#contract-publish-btn');
  if (contractPublishBtn) {
    contractPublishBtn.addEventListener('click', startContractRegistration);
  }

  // Contract back buttons
  const contractBackBtn = container.querySelector('#contract-back-btn');
  if (contractBackBtn) {
    contractBackBtn.addEventListener('click', () => {
      switch (state.step) {
        case 'contract_choose_identity':
          updateState(createInitialState(state.network));
          break;
        case 'contract_enter_identity':
          updateState({ ...state, step: 'contract_choose_identity' });
          break;
        case 'contract_enter_contract':
          if (state.contractIdentitySource === 'existing') {
            updateState({ ...state, step: 'contract_enter_identity' });
          } else {
            updateState({ ...state, step: 'contract_choose_identity' });
          }
          break;
        case 'contract_review':
          updateState({ ...state, step: 'contract_enter_contract' });
          break;
        default:
          updateState(createInitialState(state.network));
          break;
      }
    });
  }
}

/**
 * Validate identity ID format (Base58, ~44 characters)
 */
function validateIdentityId(id?: string): boolean {
  if (!id) return false;
  // Dash identity IDs are Base58 encoded, typically 43-44 characters
  return /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(id);
}

/**
 * Validate platform address format (bech32m, correct network prefix)
 */
function validatePlatformAddress(address: string, network: 'testnet' | 'mainnet'): boolean {
  const trimmed = address.trim();
  if (!trimmed) return false;

  try {
    const decoded = bech32m.decode(trimmed as `${string}1${string}`);
    return decoded.prefix === getNetwork(network).platformHrp;
  } catch {
    return false;
  }
}

/**
 * Show validation error message in the UI
 */
function showValidationError(message: string): void {
  const validationMsg = document.getElementById('validation-msg');
  if (validationMsg) {
    validationMsg.textContent = message;
    validationMsg.classList.remove('hidden');
  }
}

/**
 * Start the top-up process
 */
async function startTopUp() {
  try {
    const network = getNetwork(state.network);

    // Step 1: Generate random one-time key pair (NOT HD-derived)
    updateState(setStep(state, 'generating_keys'));

    const assetLockKeyPair = generateKeyPair();
    const depositAddress = publicKeyToAddress(assetLockKeyPair.publicKey, network);

    const stateWithKeys = setOneTimeKeyPair(state, assetLockKeyPair, depositAddress);
    updateState(stateWithKeys);

    // Auto-download key backup immediately for safety
    // CRITICAL: User must have this to recover funds if something goes wrong
    downloadKeyBackup(stateWithKeys);

    // Step 2: Wait for deposit
    updateState(setStep(stateWithKeys, 'detecting_deposit'));

    const minAmount = state.minimumDeposit || 300000; // custom or 0.003 DASH minimum
    const depositResult = await insightClient.waitForUtxo(
      depositAddress,
      minAmount,
      120000, // 2 minutes before showing recheck button
      3000    // poll every 3 seconds
    );

    // Handle timeout - show recheck button with any detected amount
    if (!depositResult.utxo) {
      updateState(setDepositTimedOut(state, true, depositResult.totalAmount));
      return;
    }

    const utxo = depositResult.utxo;

    updateState(setUtxoDetected(state, utxo));

    // Step 3: Build transaction
    updateState(setStep(state, 'building_transaction'));

    const tx = createAssetLockTransaction(
      utxo,
      assetLockKeyPair.publicKey,
      BigInt(network.minFee)
    );

    // Step 4: Sign transaction
    updateState(setStep(state, 'signing_transaction'));

    const signedTx = await signTransaction(
      tx,
      [utxo],
      assetLockKeyPair.privateKey,
      assetLockKeyPair.publicKey
    );

    const signedTxBytes = serializeTransaction(signedTx);
    const signedTxHex = bytesToHex(signedTxBytes);

    updateState(setTransactionSigned(state, signedTxHex));

    // Step 5: Broadcast transaction
    const txid = await insightClient.broadcastTransaction(signedTxHex);

    updateState(setTransactionBroadcast(state, txid));

    // Step 6: Wait for InstantSend lock
    updateState(setStep(state, 'waiting_islock'));

    console.log('Waiting for InstantSend lock...');
    const islockBytes = await dapiClient.waitForInstantSendLock(txid, 60000);
    console.log('InstantSend lock received:', islockBytes.length, 'bytes');

    const assetLockProof = buildInstantAssetLockProof(
      signedTxBytes,
      islockBytes,
      0
    );

    updateState(setInstantLockReceived(state, islockBytes, assetLockProof));

    // Step 7: Top up identity (different from create)
    updateState(setStep(state, 'topping_up'));

    const assetLockPrivateKeyWif = privateKeyToWif(
      assetLockKeyPair.privateKey,
      network
    );

    await topUpIdentity(
      state.targetIdentityId!,
      assetLockProof,
      assetLockPrivateKeyWif,
      state.network
    );

    updateState(setTopUpComplete(state));

  } catch (error) {
    console.error('Top-up error:', error);
    updateState(setError(state, toError(error)));
  }
}

/**
 * Start the send-to-platform-address process (asset lock → send to recipient address)
 */
async function startSendToAddress() {
  try {
    const network = getNetwork(state.network);

    // Step 1: Generate random one-time key pair
    updateState(setStep(state, 'generating_keys'));

    const assetLockKeyPair = generateKeyPair();
    const depositAddress = publicKeyToAddress(assetLockKeyPair.publicKey, network);

    const stateWithKeys = setOneTimeKeyPair(state, assetLockKeyPair, depositAddress);
    updateState(stateWithKeys);

    // Auto-download key backup for safety
    downloadKeyBackup(stateWithKeys);

    // Step 2: Wait for deposit
    updateState(setStep(stateWithKeys, 'detecting_deposit'));

    const minAmount = state.minimumDeposit || 300000; // custom or 0.003 DASH minimum
    const depositResult = await insightClient.waitForUtxo(
      depositAddress,
      minAmount,
      120000,
      3000
    );

    if (!depositResult.utxo) {
      updateState(setDepositTimedOut(state, true, depositResult.totalAmount));
      return;
    }

    const utxo = depositResult.utxo;
    updateState(setUtxoDetected(state, utxo));

    // Step 3: Build transaction
    updateState(setStep(state, 'building_transaction'));

    const tx = createAssetLockTransaction(
      utxo,
      assetLockKeyPair.publicKey,
      BigInt(network.minFee)
    );

    // Step 4: Sign transaction
    updateState(setStep(state, 'signing_transaction'));

    const signedTx = await signTransaction(
      tx,
      [utxo],
      assetLockKeyPair.privateKey,
      assetLockKeyPair.publicKey
    );

    const signedTxBytes = serializeTransaction(signedTx);
    const signedTxHex = bytesToHex(signedTxBytes);

    updateState(setTransactionSigned(state, signedTxHex));

    // Step 5: Broadcast transaction
    const txid = await insightClient.broadcastTransaction(signedTxHex);
    updateState(setTransactionBroadcast(state, txid));

    // Step 6: Wait for InstantSend lock
    updateState(setStep(state, 'waiting_islock'));

    const islockBytes = await dapiClient.waitForInstantSendLock(txid, 60000);

    const assetLockProof = buildInstantAssetLockProof(
      signedTxBytes,
      islockBytes,
      0
    );

    updateState(setInstantLockReceived(state, islockBytes, assetLockProof));

    // Step 7: Send to the recipient platform address
    updateState(setStep(state, 'sending_to_address'));

    const assetLockPrivateKeyWif = privateKeyToWif(
      assetLockKeyPair.privateKey,
      network
    );

    await sendToPlatformAddress(
      state.recipientPlatformAddress!,
      assetLockProof,
      assetLockPrivateKeyWif,
      state.network
    );

    updateState(setSendToAddressComplete(state));

  } catch (error) {
    console.error('Send to platform address error:', error);
    updateState(setError(state, toError(error)));
  }
}

/**
 * Start the bridge process (identity creation)
 */
async function startBridge() {
  try {
    const network = getNetwork(state.network);

    // Ensure mnemonic exists
    if (!state.mnemonic) {
      throw new Error('No mnemonic available for HD derivation');
    }

    // Step 1: Derive asset lock key from mnemonic (identity keys are pre-configured in state)
    updateState(setStep(state, 'generating_keys'));

    const { privateKey, publicKey } = deriveAssetLockKeyPair(state.mnemonic, state.network);
    const assetLockKeyPair = { privateKey, publicKey };
    const depositAddress = publicKeyToAddress(assetLockKeyPair.publicKey, network);

    updateState(
      setKeyPairs(state, assetLockKeyPair, depositAddress)
    );

    // Auto-download key backup immediately for safety
    // This ensures users can recover funds if they reload the page
    downloadKeyBackup(state);

    // Step 2: Wait for deposit
    updateState(setStep(state, 'detecting_deposit'));

    const minAmount = state.minimumDeposit || 300000; // custom or 0.003 DASH minimum
    const depositResult = await insightClient.waitForUtxo(
      depositAddress,
      minAmount,
      120000, // 2 minutes before showing recheck button
      3000    // poll every 3 seconds
    );

    // Handle timeout - show recheck button with any detected amount
    if (!depositResult.utxo) {
      updateState(setDepositTimedOut(state, true, depositResult.totalAmount));
      return;
    }

    const utxo = depositResult.utxo;

    updateState(setUtxoDetected(state, utxo));

    // Step 3: Build transaction
    updateState(setStep(state, 'building_transaction'));

    const tx = createAssetLockTransaction(
      utxo,
      assetLockKeyPair.publicKey,
      BigInt(network.minFee)
    );

    // Step 4: Sign transaction
    updateState(setStep(state, 'signing_transaction'));

    const signedTx = await signTransaction(
      tx,
      [utxo],
      assetLockKeyPair.privateKey,
      assetLockKeyPair.publicKey
    );

    const signedTxBytes = serializeTransaction(signedTx);
    const signedTxHex = bytesToHex(signedTxBytes);

    updateState(setTransactionSigned(state, signedTxHex));

    // Step 5: Broadcast transaction
    const txid = await insightClient.broadcastTransaction(signedTxHex);

    updateState(setTransactionBroadcast(state, txid));

    // Step 6: Wait for InstantSend lock
    updateState(setStep(state, 'waiting_islock'));

    console.log('Waiting for InstantSend lock...');
    const islockBytes = await dapiClient.waitForInstantSendLock(txid, 60000);
    console.log('InstantSend lock received:', islockBytes.length, 'bytes');

    const assetLockProof = buildInstantAssetLockProof(
      signedTxBytes,
      islockBytes,
      0
    );

    updateState(setInstantLockReceived(state, islockBytes, assetLockProof));

    // Step 7: Register identity
    updateState(setStep(state, 'registering_identity'));

    const assetLockPrivateKeyWif = privateKeyToWif(
      assetLockKeyPair.privateKey,
      network
    );

    const result = await registerIdentity(
      assetLockProof,
      assetLockPrivateKeyWif,
      state.identityKeys,
      state.network
    );

    updateState(setIdentityRegistered(state, result.identityId));

    // Auto-download final key backup on "Save your keys" page
    // This backup includes the identity ID in the filename
    // (Earlier download at deposit step used pending filename)
    downloadKeyBackup(state);

    // Auto-publish contract if this identity was created for contract registration
    if (await autoPublishContractIfNeeded(result.identityId)) return;

  } catch (error) {
    console.error('Bridge error:', error);
    updateState(setError(state, toError(error)));
  }
}

/**
 * Recheck for deposit (called when user clicks "Check Again" after timeout)
 */
async function recheckDeposit() {
  if (!state.depositAddress) {
    console.error('No deposit address available');
    return;
  }

  // Reset timeout state and start polling again
  updateState(setDepositTimedOut(state, false, 0));

  const minAmount = state.minimumDeposit || 300000; // custom or 0.003 DASH minimum
  const depositResult = await insightClient.waitForUtxo(
    state.depositAddress,
    minAmount,
    120000, // 2 minutes before showing recheck button
    3000    // poll every 3 seconds
  );

  // Handle timeout - show recheck button again with any detected amount
  if (!depositResult.utxo) {
    updateState(setDepositTimedOut(state, true, depositResult.totalAmount));
    return;
  }

  const utxo = depositResult.utxo;

  // Continue with the rest of the bridge process
  try {
    const network = getNetwork(state.network);
    const assetLockKeyPair = state.assetLockKeyPair!;

    updateState(setUtxoDetected(state, utxo));

    // Step 3: Build transaction
    updateState(setStep(state, 'building_transaction'));

    const tx = createAssetLockTransaction(
      utxo,
      assetLockKeyPair.publicKey,
      BigInt(network.minFee)
    );

    // Step 4: Sign transaction
    updateState(setStep(state, 'signing_transaction'));

    const signedTx = await signTransaction(
      tx,
      [utxo],
      assetLockKeyPair.privateKey,
      assetLockKeyPair.publicKey
    );

    const signedTxBytes = serializeTransaction(signedTx);
    const signedTxHex = bytesToHex(signedTxBytes);

    updateState(setTransactionSigned(state, signedTxHex));

    // Step 5: Broadcast transaction
    const txid = await insightClient.broadcastTransaction(signedTxHex);

    updateState(setTransactionBroadcast(state, txid));

    // Step 6: Wait for InstantSend lock
    updateState(setStep(state, 'waiting_islock'));

    console.log('Waiting for InstantSend lock...');
    const islockBytes = await dapiClient.waitForInstantSendLock(txid, 60000);
    console.log('InstantSend lock received:', islockBytes.length, 'bytes');

    const assetLockProof = buildInstantAssetLockProof(
      signedTxBytes,
      islockBytes,
      0
    );

    updateState(setInstantLockReceived(state, islockBytes, assetLockProof));

    // Step 7: Mode-specific final operation
    const assetLockPrivateKeyWif = privateKeyToWif(
      assetLockKeyPair.privateKey,
      network
    );

    if (state.mode === 'topup') {
      updateState(setStep(state, 'topping_up'));
      await topUpIdentity(
        state.targetIdentityId!,
        assetLockProof,
        assetLockPrivateKeyWif,
        state.network
      );
      updateState(setTopUpComplete(state));
    } else if (state.mode === 'send_to_address') {
      updateState(setStep(state, 'sending_to_address'));
      await sendToPlatformAddress(
        state.recipientPlatformAddress!,
        assetLockProof,
        assetLockPrivateKeyWif,
        state.network
      );
      updateState(setSendToAddressComplete(state));
    } else if (state.mode === 'create') {
      // Create mode — register identity
      updateState(setStep(state, 'registering_identity'));
      const result = await registerIdentity(
        assetLockProof,
        assetLockPrivateKeyWif,
        state.identityKeys,
        state.network
      );
      updateState(setIdentityRegistered(state, result.identityId));
      // Auto-download final key backup on "Save your keys" page
      downloadKeyBackup(state);

      // Auto-publish contract if applicable
      if (await autoPublishContractIfNeeded(result.identityId)) return;
    } else {
      throw new Error(`recheckDeposit: unexpected mode '${state.mode}'`);
    }

  } catch (error) {
    console.error('Bridge error:', error);
    updateState(setError(state, toError(error)));
  }
}

// ============================================================================
// Contract Registration Functions
// ============================================================================

/**
 * Auto-publish contract after identity creation if the identity was created
 * for contract registration. Finds the first suitable auth key and publishes.
 * Returns true if contract publishing was initiated, false otherwise.
 */
async function autoPublishContractIfNeeded(identityId: string): Promise<boolean> {
  if (!state.contractFromIdentityCreation || !state.contractJson) return false;

  const authKey = state.identityKeys.find(
    (k) => k.purpose === 'AUTHENTICATION' && (k.securityLevel === 'HIGH' || k.securityLevel === 'CRITICAL'),
  );
  if (!authKey) return false;

  state = { ...state, contractPrivateKeyWif: authKey.privateKeyWif, contractPublicKeyId: authKey.id, identityId };
  await startContractRegistration();
  return true;
}

/**
 * Start contract registration (for existing identity route or post-identity-creation)
 */
async function startContractRegistration() {
  try {
    const identityId = state.identityId || state.targetIdentityId;
    const privateKeyWif = state.contractPrivateKeyWif;
    const publicKeyId = state.contractPublicKeyId ?? 0;

    if (!identityId || !privateKeyWif || !state.contractJson) {
      throw new Error('Missing required data for contract registration');
    }

    updateState(setContractRegistering(state));

    const contractJson = JSON.parse(state.contractJson);
    const documentSchemas = extractDocumentSchemas(contractJson);
    const tokens = contractJson.tokens;

    const result = await publishContract(
      identityId,
      documentSchemas,
      tokens,
      publicKeyId,
      privateKeyWif,
      state.network,
    );

    updateState(setContractComplete(state, result.contractId));
  } catch (error) {
    console.error('Contract registration error:', error);
    updateState(setError(state, toError(error)));
  }
}

// ============================================================================
// DPNS Functions
// ============================================================================

/**
 * Start DPNS availability check
 */
async function startDpnsCheck() {
  try {
    const usernames = state.dpnsUsernames || [];
    const validUsernames = usernames.filter((u) => u.isValid);

    if (validUsernames.length === 0) {
      return;
    }

    // Transition to checking state
    updateState(setDpnsChecking(state));

    // Check availability for all valid usernames
    const results = await checkMultipleAvailability(validUsernames, state.network);

    // Update state with results
    updateState(setDpnsAvailability(state, results));

  } catch (error) {
    console.error('DPNS check error:', error);
    updateState(setError(state, toError(error)));
  }
}

/**
 * Start DPNS registration
 */
async function startDpnsRegistration() {
  try {
    const usernames = state.dpnsUsernames || [];
    const availableUsernames = usernames.filter((u) => u.isValid && u.isAvailable);

    if (availableUsernames.length === 0) {
      return;
    }

    // Get identity ID and private key
    const identityId = state.identityId || state.targetIdentityId;
    const privateKeyWif = state.dpnsPrivateKeyWif;
    const publicKeyId = state.dpnsPublicKeyId ?? 0;

    if (!identityId) {
      throw new Error('No identity ID available for DPNS registration');
    }

    if (!privateKeyWif) {
      throw new Error('No private key available for DPNS registration');
    }

    // Transition to registering state
    updateState(setDpnsRegistering(state));

    // Register all available usernames
    const results = await registerMultipleNames(
      availableUsernames,
      identityId,
      publicKeyId,
      privateKeyWif,
      state.network,
      (current, total, label) => {
        console.log(`Registering ${label} (${current}/${total})...`);
        updateState(setDpnsRegistrationProgress(state, current - 1));
      }
    );

    // Update state with results
    updateState(setDpnsResults(state, results));

  } catch (error) {
    console.error('DPNS registration error:', error);
    updateState(setError(state, toError(error)));
  }
}

// ============================================================================
// Identity Management Functions
// ============================================================================

/**
 * Execute the identity update operation
 */
async function startManageUpdate() {
  try {
    updateState(setManageUpdating(state));

    // Prepare keys to add
    const addPublicKeys: AddKeyConfig[] = (state.manageKeysToAdd || []).map(key => ({
      keyType: key.keyType,
      purpose: key.purpose,
      securityLevel: key.securityLevel,
      privateKeyHex: key.source === 'generate' ? key.generatedKey?.privateKeyHex : undefined,
      publicKeyHex: key.source === 'generate' ? key.generatedKey?.publicKeyHex : undefined,
      publicKeyBase64: key.source === 'import' ? key.importedPublicKeyBase64 : undefined,
      privateKeyWif: key.source === 'generate' ? key.generatedKey?.privateKeyWif : undefined,
    }));

    // Get key IDs to disable
    const disablePublicKeyIds = state.manageKeyIdsToDisable || [];

    // Validate we have something to do
    if (addPublicKeys.length === 0 && disablePublicKeyIds.length === 0) {
      updateState(setManageComplete(state, { success: false, error: 'No changes to apply' }));
      return;
    }

    // Validate we have required data
    if (!state.targetIdentityId) {
      updateState(setManageComplete(state, { success: false, error: 'No identity ID' }));
      return;
    }

    if (!state.managePrivateKeyWif) {
      updateState(setManageComplete(state, { success: false, error: 'No signing key' }));
      return;
    }

    // Execute update
    const result = await updateIdentity(
      state.targetIdentityId,
      state.managePrivateKeyWif,
      addPublicKeys,
      disablePublicKeyIds,
      state.network
    );

    updateState(setManageComplete(state, result));

  } catch (error) {
    console.error('Identity update error:', error);
    // WasmSdkError is not a standard Error, so check for message property
    const errorMessage = (error && typeof error === 'object' && 'message' in error)
      ? String((error as { message: unknown }).message)
      : (error instanceof Error ? error.message : String(error));
    updateState(setManageComplete(state, {
      success: false,
      error: errorMessage,
    }));
  }
}

// ============================================================================
// Faucet Functions
// ============================================================================

/**
 * Request testnet funds from the faucet
 */
async function requestFaucetFunds() {
  const network = getNetwork(state.network);

  // Only available on testnet
  if (!network.faucetBaseUrl || !state.depositAddress) {
    return;
  }

  // Prevent duplicate requests
  if (state.faucetRequestStatus === 'solving_pow' ||
      state.faucetRequestStatus === 'requesting') {
    return;
  }

  try {
    // Step 1: Check if CAP is required
    const status = await getFaucetStatus(network.faucetBaseUrl);

    let capToken: string | undefined;
    if (status.capEndpoint) {
      // Step 2: Solve proof-of-work
      updateState(setFaucetSolvingPow(state));

      try {
        capToken = await solveCap(status.capEndpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Proof of work failed';
        updateState(setFaucetError(state, message));
        return;
      }
    }

    // Step 3: Request funds
    updateState(setFaucetRequesting(state));

    const result = await requestTestnetFunds(
      network.faucetBaseUrl,
      state.depositAddress,
      1.0,  // 1 DASH
      capToken
    );

    updateState(setFaucetSuccess(state, result.txid));

    // Capture address before async delay to avoid stale state reference
    const addressToCheck = state.depositAddress;

    // Quick UTXO check 250ms after faucet sends funds
    setTimeout(async () => {
      if (!addressToCheck) return;

      // Verify we're still on the deposit step before proceeding
      if (state.step !== 'detecting_deposit') return;

      try {
        const utxos = await insightClient.getUTXOs(addressToCheck);
        const minAmount = state.minimumDeposit || 300000; // custom or 0.003 DASH minimum
        const sufficientUtxo = utxos.find(u => u.satoshis >= minAmount);
        if (sufficientUtxo && state.step === 'detecting_deposit') {
          updateState(setUtxoDetected(state, sufficientUtxo));
        }
      } catch {
        // Ignore - regular polling will catch it
      }
    }, 250);

  } catch (error) {
    console.error('Faucet request error:', error);
    const message = error instanceof Error ? error.message : 'Failed to connect to faucet';
    updateState(setFaucetError(state, message));
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

import { getNetwork, initNetworkRegistry, createCustomDevnetConfig, saveCustomDevnet, isReservedNetworkName, MAINNET, TESTNET } from './config.js';
import { publicKeyToAddress, signTransaction, generateKeyPair } from './crypto/index.js';
import { deriveAssetLockKeyPair } from './crypto/hd.js';
import { createAssetLockTransaction, serializeTransaction, calculateTxId } from './transaction/index.js';
import { InsightClient } from './api/insight.js';
import type { IslockService } from './api/islock.js';
import { fetchNetworkStatus } from './api/network-status.js';
import { DAPIClient } from './api/dapi.js';
import { buildInstantAssetLockProof, buildChainAssetLockProof } from './proof/index.js';
import { bech32m } from '@scure/base';
import { privateKeyToWif, bytesToHex, abortableSleep } from './utils/index.js';
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
  setChainlockFallbackStarted,
  setChainlockProgress,
  setChainlockProofReady,
  toError,
  ErrorCodes,
  setDepositTimedOut,
  setNetwork,
  setNetworkStatus,
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
import { isContestedUsername } from './platform/dpns.js';
import {
  findMatchingKeyIndex,
  isSecurityLevelAllowedForDpns,
  isPurposeAllowedForDpns,
  getSecurityLevelName,
  getPurposeName,
  generateIdentityKey,
} from './crypto/keys.js';
import {
  loadContractModule,
  loadDpnsModule,
  loadFeeEstimatorModule,
  loadIslockModule,
  loadPlatformClientModule,
  loadPlatformModule,
  warmDashModules,
} from './platform/loaders.js';
import { loadSdkModule } from './platform/sdkModule.js';
import type {
  BridgeState,
  KeyType,
  KeyPurpose,
  SecurityLevel,
  UTXO,
  ManageNewKeyConfig,
  DpnsUsernameEntry,
  DpnsRegistrationResult,
  IdentityPublicKeyInfo,
  E2EMockWindow,
  AssetLockProofData,
} from './types.js';
import type { AddKeyConfig } from './platform/index.js';
import {
  E2E_MOCK_DPNS_WIF,
  E2E_MOCK_IDENTITY_ID,
  E2E_MOCK_MANAGE_WIF,
} from './e2e-mock-constants.js';

// Global state
let state: BridgeState;
let insightClient: InsightClient;
let islockService: IslockService | undefined;
let clientInitPromise: Promise<void> | undefined;
let warmupScheduled = false;
let warmupStarted = false;

async function initClients(network: string): Promise<void> {
  const config = getNetwork(network);
  insightClient = new InsightClient(config);
  const { IslockService } = await loadIslockModule();
  islockService = new IslockService({
    network,
    rpcUrl: config.rpcUrl,
    dapiAddresses: config.dapiAddresses,
  });
  startNetworkStatusPolling();
}

function ensureClients(): Promise<void> {
  if (!clientInitPromise) {
    clientInitPromise = initClients(state.network).catch((err) => {
      clientInitPromise = undefined;
      throw err;
    });
  }
  return clientInitPromise;
}

function scheduleDashWarmup(): void {
  if (warmupScheduled || warmupStarted) return;
  warmupScheduled = true;

  const requestIdle = (window as typeof window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  }).requestIdleCallback;

  if (requestIdle) {
    requestIdle(preloadDashWarmup, { timeout: 1500 });
  } else {
    window.setTimeout(preloadDashWarmup, 1000);
  }
}

function preloadDashWarmup(): void {
  if (warmupStarted) return;
  warmupScheduled = true;
  warmupStarted = true;
  void warmDashModules();
  void ensureClients().catch((err) => console.warn('Dash warmup failed:', err));
}

// ── Network-status polling ──────────────────────────────────────────────────
// Periodically compares Core (Insight) height against Platform (DAPI) status
// so the header can warn when Platform consensus stalls while Core keeps
// moving. Re-renders only when the health verdict (or its reasons) changes, to
// avoid disrupting the UI on every tick.
const NETWORK_STATUS_POLL_MS = 30_000;
let networkStatusTimer: ReturnType<typeof setInterval> | undefined;
let networkStatusGeneration = 0;
let lastNetworkStatusKey: string | undefined;

function stopNetworkStatusPolling(): void {
  if (networkStatusTimer !== undefined) {
    clearInterval(networkStatusTimer);
    networkStatusTimer = undefined;
  }
  // Bump the generation so any in-flight fetch result is ignored.
  networkStatusGeneration += 1;
  lastNetworkStatusKey = undefined;
}

function startNetworkStatusPolling(): void {
  if (!insightClient || !islockService) return;
  stopNetworkStatusPolling();
  const generation = networkStatusGeneration;
  const insight = insightClient;
  const islock = islockService;

  const poll = async (): Promise<void> => {
    try {
      const status = await fetchNetworkStatus(insight, islock);
      // Ignore results from a superseded network/client.
      if (generation !== networkStatusGeneration) return;

      const key = `${status.health}|${status.reasons.join('|')}`;
      if (key === lastNetworkStatusKey) return;
      lastNetworkStatusKey = key;
      updateState(setNetworkStatus(state, status));
    } catch (err) {
      console.warn('Network status poll failed:', err);
    }
  };

  void poll();
  networkStatusTimer = setInterval(() => void poll(), NETWORK_STATUS_POLL_MS);
}

function switchNetwork(network: string): void {
  // Tear down any active IS lock subscriptions/polling before replacing clients
  if (islockService) {
    islockService.disconnect().catch((err) => console.warn('Error disconnecting IslockService:', err));
  }
  updateState(setNetwork(state, network));
  clientInitPromise = undefined;
  warmupScheduled = false;
  warmupStarted = false;
  void ensureClients().catch((err) => console.warn('Client initialization failed:', err));
  scheduleDashWarmup();
}

function showCustomDevnetModal(existing?: { name?: string; insightApiUrl?: string; dapiAddresses?: string; rpcUrl?: string; faucetBaseUrl?: string; useTrustedContext?: boolean; trustedQuorumUrl?: string }): void {
  const overlay = document.createElement('div');
  overlay.className = 'devnet-modal-overlay';
  overlay.innerHTML = `
    <div class="devnet-modal">
      <h2>Custom devnet</h2>
      <label>Name <input id="d-name" placeholder="my-devnet"></label>
      <label>Insight API URL <input id="d-insight" placeholder="https://insight.my-devnet.example.com/insight-api"></label>
      <label>DAPI Addresses (one HTTPS URL per line) <textarea id="d-dapi" placeholder="https://1.2.3.4:1443&#10;https://5.6.7.8:1443"></textarea></label>
      <label>JSON-RPC URL for IS locks (optional) <input id="d-rpc" placeholder="https://rpc.my-devnet.example.com"></label>
      <label>Faucet URL (optional) <input id="d-faucet"></label>
      <label><input type="checkbox" id="d-trusted"> Use trusted context (verify proofs; required for top-up &amp; identity update)</label>
      <label>Quorum context URL (optional override) <input id="d-quorum-url" placeholder="https://quorums.my-devnet.networks.dash.org"></label>
      <div class="devnet-modal-actions">
        <button class="secondary-btn" id="d-cancel">Cancel</button>
        <button class="primary-btn" id="d-save">Save &amp; Connect</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Populate via DOM properties to avoid XSS from stored values
  (overlay.querySelector('#d-name') as HTMLInputElement).value = existing?.name ?? '';
  (overlay.querySelector('#d-insight') as HTMLInputElement).value = existing?.insightApiUrl ?? '';
  (overlay.querySelector('#d-dapi') as HTMLTextAreaElement).value = existing?.dapiAddresses ?? '';
  (overlay.querySelector('#d-rpc') as HTMLInputElement).value = existing?.rpcUrl ?? '';
  (overlay.querySelector('#d-faucet') as HTMLInputElement).value = existing?.faucetBaseUrl ?? '';
  (overlay.querySelector('#d-trusted') as HTMLInputElement).checked = existing?.useTrustedContext ?? false;
  (overlay.querySelector('#d-quorum-url') as HTMLInputElement).value = existing?.trustedQuorumUrl ?? '';

  overlay.querySelector('#d-cancel')!.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#d-save')!.addEventListener('click', () => {
    const name = (overlay.querySelector('#d-name') as HTMLInputElement).value.trim();
    const insightApiUrl = (overlay.querySelector('#d-insight') as HTMLInputElement).value.trim();
    const dapiRaw = (overlay.querySelector('#d-dapi') as HTMLTextAreaElement).value.trim();
    const rpcUrl = (overlay.querySelector('#d-rpc') as HTMLInputElement).value.trim() || undefined;
    const faucetBaseUrl = (overlay.querySelector('#d-faucet') as HTMLInputElement).value.trim() || undefined;
    const useTrustedContext = (overlay.querySelector('#d-trusted') as HTMLInputElement).checked || undefined;
    const trustedQuorumUrl = (overlay.querySelector('#d-quorum-url') as HTMLInputElement).value.trim() || undefined;
    const dapiAddresses = dapiRaw.split('\n').map((s) => s.trim()).filter(Boolean);

    if (!name || !insightApiUrl || dapiAddresses.length === 0) {
      alert('Name, Insight API URL, and at least one DAPI address are required');
      return;
    }

    if (isReservedNetworkName(name)) {
      alert(`"${name}" is a reserved network name. Please choose a different name.`);
      return;
    }

    const config = createCustomDevnetConfig({
      name,
      insightApiUrl,
      dapiAddresses,
      rpcUrl,
      faucetBaseUrl,
      useTrustedContext,
      trustedQuorumUrl,
    });
    saveCustomDevnet(config);
    void loadPlatformClientModule()
      .then(({ disconnectPlatformSdk }) => disconnectPlatformSdk(name))
      .catch((err) => console.warn('Could not clear Platform SDK cache:', err));
    overlay.remove();
    switchNetwork(name);
  });
}

const E2E_MOCK_ADVANCE_TIMEOUT_MS = 30000;
const E2E_MOCK_BUILD_ENABLED = !import.meta.env.PROD;

function isE2EMockMode(): boolean {
  if (!E2E_MOCK_BUILD_ENABLED) {
    return false;
  }
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('e2e') === 'mock';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createE2EMockUtxo(): UTXO {
  return {
    txid: 'a'.repeat(64),
    vout: 0,
    satoshis: 450000,
    scriptPubKey: '76a914111111111111111111111111111111111111111188ac',
    confirmations: 1,
  };
}

function createE2EMockIdentityKeys(): IdentityPublicKeyInfo[] {
  return [
    {
      id: 0,
      type: 0,
      purpose: 0,
      securityLevel: 0,
      data: new Uint8Array(33),
      isDisabled: false,
    },
    {
      id: 1,
      type: 0,
      purpose: 0,
      securityLevel: 1,
      data: new Uint8Array(33),
      isDisabled: false,
    },
  ];
}

function createE2EMockDpnsAvailability(entries: DpnsUsernameEntry[]): DpnsUsernameEntry[] {
  return entries.map((entry) => {
    if (!entry.isValid) {
      return { ...entry, status: 'invalid' };
    }

    const lower = entry.label.toLowerCase();
    const normalizedLabel = entry.normalizedLabel || lower;
    const isAvailable = !lower.includes('taken');
    return {
      ...entry,
      normalizedLabel,
      isAvailable,
      isContested: isAvailable ? isContestedUsername(normalizedLabel) : undefined,
      status: isAvailable ? 'available' : 'taken',
    };
  });
}

function createE2EMockDpnsResults(entries: DpnsUsernameEntry[]): DpnsRegistrationResult[] {
  return entries
    .filter((entry) => entry.isValid && entry.isAvailable)
    .map((entry) => ({
      label: entry.label,
      success: !entry.label.toLowerCase().includes('fail'),
      error: entry.label.toLowerCase().includes('fail') ? 'Mock registration failure' : undefined,
      isContested: entry.isContested ?? false,
    }));
}

function clearE2EMockAdvanceHook(): void {
  (window as E2EMockWindow).__e2eMockAdvance = undefined;
}

function waitForE2EMockAdvance(timeoutMs = E2E_MOCK_ADVANCE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const mockWindow = window as E2EMockWindow;
    let timeoutId = 0;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      if (mockWindow.__e2eMockAdvance === resolveAdvance) {
        mockWindow.__e2eMockAdvance = undefined;
      }
    };

    const resolveAdvance = () => {
      cleanup();
      resolve();
    };

    mockWindow.__e2eMockAdvance = resolveAdvance;
    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for E2E mock advance after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Initialize the application
 */
function init() {
  initNetworkRegistry();

  // Close devnet dropdown on outside click (registered once)
  document.addEventListener('click', () => {
    const menu = document.getElementById('devnet-menu');
    if (menu) menu.style.display = 'none';
  });

  const urlParams = new URLSearchParams(window.location.search);

  // Infer network from ?address= param prefix, falling back to ?network= param
  let network: string = urlParams.get('network') ?? 'testnet';
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
      void hydrateContractDeepLink(contractParam);
    }
  }

  // Render UI
  const container = document.getElementById('app');
  if (container) {
    render(state, container);
    setupEventListeners(container);
  }

  scheduleDashWarmup();
}

async function hydrateContractDeepLink(contractParam: string): Promise<void> {
  try {
    const jsonStr = atob(contractParam.replace(/-/g, '+').replace(/_/g, '/'));
    const json = JSON.parse(jsonStr);
    const { parsed, estimate } = await parseAndEstimateContract(json);
    updateState(setContractJson(state, JSON.stringify(json, null, 2), parsed, estimate, undefined));
  } catch {
    // Invalid contract param, ignore
  }
}

async function getIdentityPublicKeys(identityId: string, network: string) {
  const { getIdentityPublicKeys } = await loadDpnsModule();
  return getIdentityPublicKeys(identityId, network);
}

async function getIdentityBalanceAndRevision(identityId: string, network: string) {
  const { getIdentityBalanceAndRevision } = await loadPlatformClientModule();
  return getIdentityBalanceAndRevision(identityId, network);
}

async function parseAndEstimateContract(json: unknown) {
  const { parseContractJson, estimateContractFee } = await loadFeeEstimatorModule();
  const parsed = parseContractJson(json);
  const estimate = estimateContractFee(parsed);
  return { parsed, estimate };
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
  const attachDashWarmup = (element: Element | null): void => {
    if (!element) return;
    element.addEventListener('pointerenter', preloadDashWarmup, { once: true });
    element.addEventListener('focus', preloadDashWarmup, { once: true });
    element.addEventListener('touchstart', preloadDashWarmup, { once: true });
  };

  // Network selector buttons (testnet, mainnet)
  container.querySelectorAll('.network-btn[data-network]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const network = (btn as HTMLElement).dataset.network;
      if (network && network !== state.network) {
        switchNetwork(network);
      }
    });
  });

  // Devnet dropdown toggle
  const devnetToggle = container.querySelector('#devnet-toggle');
  const devnetMenu = container.querySelector('#devnet-menu') as HTMLElement | null;
  if (devnetToggle && devnetMenu) {
    devnetToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      devnetMenu.style.display = devnetMenu.style.display === 'none' ? 'flex' : 'none';
    });
  }

  // Devnet option buttons
  container.querySelectorAll('.devnet-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const network = (btn as HTMLElement).dataset.network;
      if (network === '__custom__') {
        showCustomDevnetModal();
        return;
      }
      if (network && network !== state.network) {
        switchNetwork(network);
      }
    });
  });

  // Mode selection buttons (init page)
  const modeCreateBtn = container.querySelector('#mode-create-btn');
  attachDashWarmup(modeCreateBtn);
  if (modeCreateBtn) {
    modeCreateBtn.addEventListener('click', () => {
      updateState(setMode(state, 'create'));
    });
  }

  const modeTopUpBtn = container.querySelector('#mode-topup-btn');
  attachDashWarmup(modeTopUpBtn);
  if (modeTopUpBtn) {
    modeTopUpBtn.addEventListener('click', () => {
      updateState(setMode(state, 'topup'));
    });
  }

  // Platform Address mode button (init page)
  const modeSendToAddressBtn = container.querySelector('#mode-send-to-address-btn');
  attachDashWarmup(modeSendToAddressBtn);
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

  // Chainlock fallback button (offered on the error screen when applicable)
  const chainlockFallbackBtn = container.querySelector('#chainlock-fallback-btn');
  if (chainlockFallbackBtn) {
    chainlockFallbackBtn.addEventListener('click', () => {
      startChainlockFallback();
    });
  }

  // Cancel button shown during the waiting_chainlock step
  const chainlockCancelBtn = container.querySelector('#chainlock-cancel-btn');
  if (chainlockCancelBtn) {
    chainlockCancelBtn.addEventListener('click', () => {
      cancelChainlockFallback();
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
  attachDashWarmup(modeDpnsBtn);
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
        if (isE2EMockMode()) {
          await delay(30);
          updateState(setDpnsIdentityFetched(state, createE2EMockIdentityKeys()));
          return;
        }

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

      if (isE2EMockMode()) {
        if (privateKeyWif === E2E_MOCK_DPNS_WIF) {
          updateState(setDpnsKeyValidated(state, 1, privateKeyWif));
        } else {
          updateState(setDpnsKeyValidationError(state, 'Mock mode: use the configured test private key'));
        }
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
  attachDashWarmup(modeManageBtn);
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
        if (isE2EMockMode()) {
          await delay(30);
          updateState(setManageIdentityFetched(state, createE2EMockIdentityKeys()));
          return;
        }

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

      if (isE2EMockMode()) {
        if (privateKeyWif === E2E_MOCK_MANAGE_WIF) {
          updateState(setManageKeyValidated(state, 0, 0, privateKeyWif));
        } else {
          updateState(setManageKeyValidationError(state, 'Mock mode: use the configured test private key'));
        }
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

      if (isE2EMockMode()) {
        await delay(30);
        updateState(setManageIdentityFetched(refreshedState, createE2EMockIdentityKeys()));
        return;
      }

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
  // ============================================================================
  // Key Backup Upload Handlers (shared across DPNS, manage, contract)
  // ============================================================================

  function wireKeyUpload(
    inputId: string,
    onParsed: (result: { identityId: string; privateKeyWif: string }) => void,
  ) {
    const fileInput = container.querySelector<HTMLInputElement>(`#${inputId}`);
    const dropzone = container.querySelector<HTMLElement>(`#${inputId}-dropzone`);
    if (!fileInput) return;

    function handleFile(file: File) {
      const statusEl = container.querySelector(`#${inputId}-status`);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const json = JSON.parse(reader.result as string);
          const parsed = parseKeyBackup(json);
          if (!parsed) {
            if (statusEl) { statusEl.textContent = 'No identity or keys found in file'; statusEl.className = 'key-upload-status error'; }
            return;
          }
          if (statusEl) { statusEl.textContent = `Loaded: ${parsed.identityId.slice(0, 8)}... (${parsed.purpose} / ${parsed.securityLevel})`; statusEl.className = 'key-upload-status success'; }
          onParsed(parsed);
        } catch {
          if (statusEl) { statusEl.textContent = 'Invalid JSON file'; statusEl.className = 'key-upload-status error'; }
        }
      };
      reader.readAsText(file);
    }

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) handleFile(file);
    });

    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
      dropzone.addEventListener('dragleave', () => { dropzone.classList.remove('dragover'); });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const file = e.dataTransfer?.files[0];
        if (file) handleFile(file);
      });
    }
  }

  // DPNS key upload — show loading, fetch identity, validate key, update once
  wireKeyUpload('dpns-key-upload', async (result) => {
    updateState({ ...setDpnsIdentityFetching(state, result.identityId), dpnsPrivateKeyWif: result.privateKeyWif });
    try {
      const keys = await getIdentityPublicKeys(result.identityId, state.network);
      // Build final state in one shot: fetched keys + key validation result
      let finalState = setDpnsIdentityFetched(state, keys);
      finalState = { ...finalState, dpnsPrivateKeyWif: result.privateKeyWif };
      const match = findMatchingKeyIndex(result.privateKeyWif, keys, state.network);
      if (match && isPurposeAllowedForDpns(match.purpose) && isSecurityLevelAllowedForDpns(match.securityLevel)) {
        finalState = setDpnsKeyValidated(finalState, match.keyId, result.privateKeyWif);
      } else {
        finalState = { ...finalState, dpnsKeyValidationError: match ? 'Key must be AUTHENTICATION with HIGH or CRITICAL level' : 'Key does not match any identity key' };
      }
      updateState(finalState);
    } catch (error) {
      updateState({ ...setDpnsIdentityFetchError(state, error instanceof Error ? error.message : String(error)), dpnsPrivateKeyWif: result.privateKeyWif });
    }
  });

  // Manage key upload — show loading, fetch identity, validate key, update once
  wireKeyUpload('manage-key-upload', async (result) => {
    updateState({ ...setManageIdentityFetching(state, result.identityId), managePrivateKeyWif: result.privateKeyWif });
    try {
      const keys = await getIdentityPublicKeys(result.identityId, state.network);
      let finalState = setManageIdentityFetched(state, keys);
      finalState = { ...finalState, managePrivateKeyWif: result.privateKeyWif };
      const match = findMatchingKeyIndex(result.privateKeyWif, keys, state.network);
      if (match) {
        finalState = setManageKeyValidated(finalState, match.keyId, match.securityLevel, result.privateKeyWif);
      } else {
        finalState = { ...finalState, manageKeyValidationError: 'Key does not match any identity key' };
      }
      updateState(finalState);
    } catch (error) {
      updateState({ ...setManageIdentityFetchError(state, error instanceof Error ? error.message : String(error)), managePrivateKeyWif: result.privateKeyWif });
    }
  });

  // Contract key upload — show loading, fetch identity + balance, validate key, update once
  wireKeyUpload('contract-key-upload', async (result) => {
    updateState({
      ...setContractIdentityFetching(setTargetIdentityId(state, result.identityId), result.identityId),
      contractPrivateKeyWif: result.privateKeyWif,
    });
    try {
      const keys = await getIdentityPublicKeys(result.identityId, state.network);
      let balance: number | undefined;
      try {
        const identityState = await getIdentityBalanceAndRevision(result.identityId, state.network);
        balance = identityState.balance;
      } catch { /* best-effort */ }
      // Build final state: fetched + key WIF + validation — single updateState call
      let finalState = setContractIdentityFetched(state, keys, balance);
      finalState = { ...finalState, contractPrivateKeyWif: result.privateKeyWif };
      const match = findMatchingKeyIndex(result.privateKeyWif, keys, state.network);
      if (match && isPurposeAllowedForDpns(match.purpose) && isSecurityLevelAllowedForDpns(match.securityLevel)) {
        finalState = setContractKeyValidated(finalState, match.keyId, result.privateKeyWif);
      } else {
        finalState = { ...finalState, contractKeyValidationError: match ? 'Key must be AUTHENTICATION with HIGH or CRITICAL level' : 'Key does not match any identity key' };
      }
      updateState(finalState);
    } catch (error) {
      updateState({ ...setContractIdentityFetchError(state, error instanceof Error ? error.message : String(error)), contractPrivateKeyWif: result.privateKeyWif });
    }
  });

  // ============================================================================
  // Contract Registration Event Listeners
  // ============================================================================

  // Contract mode button (init page)
  const modeContractBtn = container.querySelector('#mode-contract-btn');
  attachDashWarmup(modeContractBtn);
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
          const identityState = await getIdentityBalanceAndRevision(identityId, state.network);
          balance = identityState.balance;
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
      contractDebounceTimer = setTimeout(async () => {
        const raw = contractJsonInput.value.trim();
        if (!raw) {
          updateState(setContractJson(state, '', undefined, undefined, undefined));
          return;
        }
        try {
          const json = JSON.parse(raw);
          const { parsed, estimate } = await parseAndEstimateContract(json);
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
          contractCopyLinkBtn.textContent = 'Copied!';
          setTimeout(() => { contractCopyLinkBtn.textContent = 'Copy Link'; }, 2000);
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
 * Parse a key backup JSON file and extract identityId + best private key WIF.
 * Prefers AUTHENTICATION keys with HIGH or CRITICAL security level, since those
 * are required for DPNS and contract operations. MASTER keys are ranked lower
 * because they are rejected by isPurposeAllowedForDpns/isSecurityLevelAllowedForDpns.
 */
function parseKeyBackup(json: unknown): { identityId: string; privateKeyWif: string; purpose: string; securityLevel: string } | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const identityId = (obj.identityId || obj.targetIdentityId) as string | undefined;
  if (!identityId || typeof identityId !== 'string') return null;

  const keys = obj.identityKeys as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(keys) || keys.length === 0) return null;

  const ranked = keys
    .filter((k) => typeof k.privateKeyWif === 'string')
    .sort((a, b) => {
      // Prefer AUTHENTICATION purpose
      const aAuth = a.purpose === 'AUTHENTICATION' ? 1 : 0;
      const bAuth = b.purpose === 'AUTHENTICATION' ? 1 : 0;
      if (aAuth !== bAuth) return bAuth - aAuth;
      // Prefer HIGH/CRITICAL over MASTER (MASTER is not accepted for DPNS/contracts)
      const levelOrder: Record<string, number> = { HIGH: 4, CRITICAL: 3, MEDIUM: 2, MASTER: 1 };
      return (levelOrder[b.securityLevel as string] || 0) - (levelOrder[a.securityLevel as string] || 0);
    });

  if (ranked.length === 0) return null;
  const best = ranked[0];
  return {
    identityId,
    privateKeyWif: best.privateKeyWif as string,
    purpose: (best.purpose as string) || 'UNKNOWN',
    securityLevel: (best.securityLevel as string) || 'UNKNOWN',
  };
}

/**
 * Validate platform address format (bech32m, correct network prefix)
 */
function validatePlatformAddress(address: string, network: string): boolean {
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
    if (isE2EMockMode()) {
      const network = getNetwork(state.network);
      const assetLockKeyPair = generateKeyPair();
      const depositAddress = publicKeyToAddress(assetLockKeyPair.publicKey, network);

      updateState(setStep(state, 'generating_keys'));
      await delay(120);
      updateState(setOneTimeKeyPair(state, assetLockKeyPair, depositAddress));
      updateState(setStep(state, 'detecting_deposit'));
      clearE2EMockAdvanceHook();
      await waitForE2EMockAdvance();
      updateState(setUtxoDetected(state, createE2EMockUtxo()));
      await delay(120);
      updateState(setTransactionSigned(state, 'ab'.repeat(180)));
      await delay(120);
      updateState(setTransactionBroadcast(state, 'b'.repeat(64)));
      await delay(120);
      updateState(setInstantLockReceived(state, new Uint8Array([1, 2, 3, 4]), {
        type: 'instant',
        transactionBytes: new Uint8Array([0xc0, 0xff, 0xee]),
        instantLockBytes: new Uint8Array([1, 2, 3, 4]),
        outputIndex: 0,
      }));
      updateState(setStep(state, 'topping_up'));
      await delay(120);
      updateState(setTopUpComplete(state));
      return;
    }

    updateState(setStep(state, 'generating_keys'));
    await ensureClients();
    const islock = islockService!;
    const network = getNetwork(state.network);

    // Step 1: Generate random one-time key pair (NOT HD-derived)

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
    const txid = calculateTxId(signedTx);

    updateState(setTransactionSigned(state, signedTxHex, signedTxBytes));

    // Step 5: Open IS lock subscription BEFORE broadcasting — dashd does not
    // replay historical IS locks, so we must be listening before the lock
    // is signed (which can happen within milliseconds of broadcast).
    updateState(setStep(state, 'waiting_islock'));
    console.log('Opening IS lock subscription before broadcast...');
    const islockSub = await islock.subscribeForInstantSendLock(
      txid,
      assetLockKeyPair.publicKey,
      utxo
    );

    // Step 6: Broadcast transaction
    const broadcastedTxid = await insightClient.broadcastTransaction(signedTxHex);
    if (broadcastedTxid !== txid) {
      console.warn(`Broadcast txid ${broadcastedTxid} differs from local ${txid}`);
    }

    updateState(setTransactionBroadcast(state, txid));

    console.log('Waiting for InstantSend lock...');
    const islockBytes = await islockSub.wait();
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

    const { topUpIdentity } = await loadPlatformModule();
    await topUpIdentity(
      state.targetIdentityId!,
      assetLockProof,
      assetLockPrivateKeyWif,
      state.network
    );

    updateState(setTopUpComplete(state));

  } catch (error) {
    if (isE2EMockMode()) {
      clearE2EMockAdvanceHook();
    }
    console.error('Top-up error:', error);
    updateState(setError(state, toError(error)));
  }
}

/**
 * Start the send-to-platform-address process (asset lock → send to recipient address)
 */
async function startSendToAddress() {
  try {
    updateState(setStep(state, 'generating_keys'));
    await ensureClients();
    const islock = islockService!;
    const network = getNetwork(state.network);

    // Step 1: Generate random one-time key pair

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
    const txid = calculateTxId(signedTx);

    updateState(setTransactionSigned(state, signedTxHex, signedTxBytes));

    // Step 5: Subscribe for IS lock BEFORE broadcasting (see flow #1 for why).
    updateState(setStep(state, 'waiting_islock'));
    const islockSub = await islock.subscribeForInstantSendLock(
      txid,
      assetLockKeyPair.publicKey,
      utxo
    );

    // Step 6: Broadcast transaction
    const broadcastedTxid = await insightClient.broadcastTransaction(signedTxHex);
    if (broadcastedTxid !== txid) {
      console.warn(`Broadcast txid ${broadcastedTxid} differs from local ${txid}`);
    }
    updateState(setTransactionBroadcast(state, txid));

    const islockBytes = await islockSub.wait();

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

    const { sendToPlatformAddress } = await loadPlatformModule();
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
 * Wrapper around `registerIdentity` that gracefully handles
 * already-submitted state transitions.
 *
 * Tenderdash (Platform's consensus layer) deduplicates state transitions
 * by their bytes: a second submit of the same IdentityCreate is rejected
 * with `Object already exists: tx already exists in cache`. This is what
 * surfaces when the user retries an identity creation that actually
 * succeeded the first time (e.g. the first attempt got a
 * `GroveDBProof` decode error in the client AFTER Platform had committed
 * the identity, and the user clicked Retry).
 *
 * The rs-sdk has matching logic (`Identity::wait_for_response`) that
 * auto-fetches the identity on `AlreadyExists`, but the wasm-sdk doesn't,
 * and on a NON-TRUSTED devnet we can't fetch via the SDK anyway (no
 * quorum context = TransportNoAvailableAddresses).
 *
 * Strategy: catch the AlreadyExists family of errors and treat them as
 * success, deriving the identity ID from the asset lock proof (it's
 * deterministic). The platform-side identity is real either way.
 */
async function registerIdentityResilient(
  proof: Extract<AssetLockProofData, { type: 'instant' }>,
  assetLockPrivateKeyWif: string,
  identityKeys: typeof state.identityKeys,
  network: string
): Promise<{ identityId: string; balance: number; revision: number; alreadyExisted?: boolean }> {
  const isAlreadyExistsError = (err: unknown): boolean => {
    const msg =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
    return (
      msg.includes('Object already exists') ||
      msg.includes('tx already exists in cache') ||
      msg.includes('AlreadyExists')
    );
  };

  try {
    const { registerIdentity } = await loadPlatformModule();
    return await registerIdentity(proof, assetLockPrivateKeyWif, identityKeys, network);
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;

    // Platform tells us the state transition is already in its consensus
    // pool — meaning a previous submit already created the identity. The
    // identity ID is deterministic from the asset lock outpoint, so we
    // can derive it from the proof and surface success.
    console.log(
      '[identity-create] Platform reports state transition already submitted; treating as success.'
    );
    const { AssetLockProof } = await loadSdkModule();
    const sdkProof = AssetLockProof.createInstantAssetLockProof(
      proof.instantLockBytes,
      proof.transactionBytes,
      proof.outputIndex
    );
    const identityId = sdkProof.createIdentityId().toString();
    console.log('[identity-create] Recovered identityId:', identityId);
    return { identityId, balance: 0, revision: 0, alreadyExisted: true };
  }
}

/**
 * Start the bridge process (identity creation)
 */
async function startBridge() {
  try {
    if (isE2EMockMode()) {
      const network = getNetwork(state.network);
      const assetLockKeyPair = generateKeyPair();
      const depositAddress = publicKeyToAddress(assetLockKeyPair.publicKey, network);

      clearE2EMockAdvanceHook();
      updateState(setStep(state, 'generating_keys'));
      await delay(120);
      updateState(setKeyPairs(state, assetLockKeyPair, depositAddress));
      updateState(setStep(state, 'detecting_deposit'));
      await waitForE2EMockAdvance();
      updateState(setUtxoDetected(state, createE2EMockUtxo()));
      await delay(120);
      updateState(setTransactionSigned(state, 'cd'.repeat(180)));
      await delay(120);
      updateState(setTransactionBroadcast(state, 'd'.repeat(64)));
      await delay(120);
      updateState(setInstantLockReceived(state, new Uint8Array([5, 6, 7, 8]), {
        type: 'instant',
        transactionBytes: new Uint8Array([0xbe, 0xef]),
        instantLockBytes: new Uint8Array([5, 6, 7, 8]),
        outputIndex: 0,
      }));
      await delay(120);
      updateState(setIdentityRegistered(state, E2E_MOCK_IDENTITY_ID));
      return;
    }

    const network = getNetwork(state.network);

    // Ensure mnemonic exists
    if (!state.mnemonic) {
      throw new Error('No mnemonic available for HD derivation');
    }

    // Step 1: Derive asset lock key from mnemonic (identity keys are pre-configured in state)
    updateState(setStep(state, 'generating_keys'));
    await ensureClients();
    const islock = islockService!;

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
    const txid = calculateTxId(signedTx);

    updateState(setTransactionSigned(state, signedTxHex, signedTxBytes));

    // Step 5: Subscribe for IS lock BEFORE broadcasting (see flow #1 for why).
    updateState(setStep(state, 'waiting_islock'));
    console.log('Opening IS lock subscription before broadcast...');
    const islockSub = await islock.subscribeForInstantSendLock(
      txid,
      assetLockKeyPair.publicKey,
      utxo
    );

    // Step 6: Broadcast transaction
    const broadcastedTxid = await insightClient.broadcastTransaction(signedTxHex);
    if (broadcastedTxid !== txid) {
      console.warn(`Broadcast txid ${broadcastedTxid} differs from local ${txid}`);
    }
    updateState(setTransactionBroadcast(state, txid));

    console.log('Waiting for InstantSend lock...');
    const islockBytes = await islockSub.wait();
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

    const result = await registerIdentityResilient(
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
    if (isE2EMockMode()) {
      clearE2EMockAdvanceHook();
    }
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
  await ensureClients();
  const islock = islockService!;

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
    const txid = calculateTxId(signedTx);

    updateState(setTransactionSigned(state, signedTxHex, signedTxBytes));

    // Step 5: Subscribe for IS lock BEFORE broadcasting (see flow #1 for why).
    updateState(setStep(state, 'waiting_islock'));
    console.log('Opening IS lock subscription before broadcast...');
    const islockSub = await islock.subscribeForInstantSendLock(
      txid,
      assetLockKeyPair.publicKey,
      utxo
    );

    // Step 6: Broadcast transaction
    const broadcastedTxid = await insightClient.broadcastTransaction(signedTxHex);
    if (broadcastedTxid !== txid) {
      console.warn(`Broadcast txid ${broadcastedTxid} differs from local ${txid}`);
    }
    updateState(setTransactionBroadcast(state, txid));

    console.log('Waiting for InstantSend lock...');
    const islockBytes = await islockSub.wait();
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
      const { topUpIdentity } = await loadPlatformModule();
      await topUpIdentity(
        state.targetIdentityId!,
        assetLockProof,
        assetLockPrivateKeyWif,
        state.network
      );
      updateState(setTopUpComplete(state));
    } else if (state.mode === 'send_to_address') {
      updateState(setStep(state, 'sending_to_address'));
      const { sendToPlatformAddress } = await loadPlatformModule();
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
      const result = await registerIdentityResilient(
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
// ChainLock Fallback
// ============================================================================

/**
 * Active poller controller for the chainlock fallback. Module-scoped so the
 * cancel button can abort it without threading it through render state.
 */
let chainlockController: AbortController | null = null;

/**
 * Run the mode-appropriate Platform submission with the supplied proof.
 * Shared by the chainlock fallback path; mirrors the per-mode tail of the
 * happy-path bridge flows (see startBridge / startTopUp / startSendToAddress).
 */
async function runPlatformSubmission(
  assetLockProof: import('./types.js').AssetLockProofData,
  assetLockPrivateKeyWif: string
): Promise<void> {
  if (state.mode === 'topup') {
    updateState(setStep(state, 'topping_up'));
    const { topUpIdentity } = await loadPlatformModule();
    await topUpIdentity(
      state.targetIdentityId!,
      assetLockProof,
      assetLockPrivateKeyWif,
      state.network
    );
    updateState(setTopUpComplete(state));
    return;
  }

  if (state.mode === 'send_to_address') {
    updateState(setStep(state, 'sending_to_address'));
    const { sendToPlatformAddress } = await loadPlatformModule();
    await sendToPlatformAddress(
      state.recipientPlatformAddress!,
      assetLockProof,
      assetLockPrivateKeyWif,
      state.network
    );
    updateState(setSendToAddressComplete(state));
    return;
  }

  if (state.mode === 'create') {
    updateState(setStep(state, 'registering_identity'));
    // registerIdentityResilient derives the identity ID from the asset lock
    // outpoint on AlreadyExists, which only applies to instant proofs here.
    // Chain proofs go straight to registerIdentity.
    let result;
    if (assetLockProof.type === 'instant') {
      result = await registerIdentityResilient(
        assetLockProof,
        assetLockPrivateKeyWif,
        state.identityKeys,
        state.network
      );
    } else {
      const { registerIdentity } = await loadPlatformModule();
      result = await registerIdentity(
        assetLockProof,
        assetLockPrivateKeyWif,
        state.identityKeys,
        state.network
      );
    }
    updateState(setIdentityRegistered(state, result.identityId));
    downloadKeyBackup(state);

    if (await autoPublishContractIfNeeded(result.identityId)) return;
    return;
  }

  throw new Error(`runPlatformSubmission: unexpected mode '${state.mode}'`);
}

/**
 * Cancel an in-flight chainlock fallback and return to the prior error screen
 * (with a generic CHAINLOCK error code so the user understands what happened).
 */
function cancelChainlockFallback(): void {
  if (!chainlockController) return;
  chainlockController.abort();
  chainlockController = null;
  updateState(setError(state, new Error('Chainlock fallback cancelled'), ErrorCodes.CHAINLOCK));
}

/**
 * Begin the chainlock fallback flow: poll Insight for the asset-lock tx's
 * confirming block, poll Platform (with DAPI JSON-RPC as backup) for the
 * chain-locked tip, and once `coreChainLockedHeight >= blockHeight` build a
 * chain asset lock proof and resubmit the original Platform operation.
 */
async function startChainlockFallback(): Promise<void> {
  if (!state.txid || !state.assetLockKeyPair) {
    console.error('Chainlock fallback unavailable: missing txid or asset lock key pair');
    return;
  }

  if (chainlockController) {
    chainlockController.abort();
  }
  chainlockController = new AbortController();
  const signal = chainlockController.signal;

  updateState(setChainlockFallbackStarted(state));
  await ensureClients();
  const islock = islockService!;

  const network = getNetwork(state.network);
  const txid = state.txid;
  const dapiClient = new DAPIClient({ network: state.network, rpcUrl: network.rpcUrl });

  // Poll #1: asset lock tx block height via Insight.
  const blockHeightPromise = insightClient.waitForBlockHeight(
    txid,
    5000,
    signal,
    (info) => {
      if (info.blockheight !== undefined) {
        updateState(setChainlockProgress(state, { blockHeight: info.blockheight }));
      }
    }
  );

  // Poll #2: chain-locked Dash Core height. DAPI JSON-RPC
  // `getbestchainlock` first (when an rpcUrl is configured), then direct
  // gRPC `platform.getStatus()` via @dashevo/dapi-client. We intentionally
  // do NOT use `sdk.system.status()`: in pre-dev.7 builds the testnet
  // trusted context returned testnet-cached values on devnets. SDK
  // 3.1.0-dev.7 fixes this with per-devnet trusted contexts, but the
  // direct dapi-client call works uniformly across trusted and
  // non-trusted devnets, so we keep it.
  const chainLockPoll = (async (): Promise<void> => {
    while (!signal.aborted) {
      let height: number | undefined;
      try {
        const observed = await dapiClient.getBestChainLock();
        if (observed) height = observed.height;
      } catch (error) {
        console.warn('getBestChainLock failed:', error);
      }
      if (height === undefined) {
        try {
          height = await islock.getCoreChainLockedHeight();
        } catch (error) {
          console.warn('platform.getStatus core chain locked height failed:', error);
        }
      }
      if (height !== undefined) {
        updateState(setChainlockProgress(state, { chainLockedHeight: height }));
      }
      await abortableSleep(5000, signal);
    }
  })();
  chainLockPoll.catch(() => {});

  // Tracks whether we've already handed off to the Platform submission. Once
  // true, errors should use the step's natural error code (REGISTER / TOPUP /
  // SEND_ADDRESS), NOT ErrorCodes.CHAINLOCK — so the user sees the actual
  // submission failure rather than a generic chainlock label.
  let submissionStarted = false;

  try {
    console.log('[chainlock-fallback] waiting for asset lock tx to be mined…');
    const blockHeight = await blockHeightPromise;
    console.log(`[chainlock-fallback] asset lock tx confirmed at block ${blockHeight}`);

    // Wait for an actual chain-lock observation that buries the tx's block.
    // No confirmations-based fallback — submitting a chain proof without
    // having seen a real chain-locked tip would just be guessing, and
    // Platform would reject it anyway.
    while (!signal.aborted) {
      const chainLockedHeight = state.coreChainLockedHeight;
      if (chainLockedHeight !== undefined && chainLockedHeight >= blockHeight) {
        break;
      }
      await abortableSleep(2000, signal);
    }

    if (signal.aborted) {
      return;
    }

    const chainLockedHeight = state.coreChainLockedHeight!;
    // Use the tx's confirming block height as the proof value (the minimum
    // valid value, and the one Platform can unambiguously correlate back to
    // the asset lock tx). The observed chain-lock tip just tells us Platform
    // has caught up far enough to verify.
    console.log(
      `[chainlock-fallback] chain locked through block ${chainLockedHeight} (>= ${blockHeight}); ` +
        `building chain asset lock proof for ${txid}:0 with coreChainLockedHeight=${blockHeight}`
    );
    const proof = buildChainAssetLockProof(txid, 0, blockHeight);
    updateState(setChainlockProofReady(state, proof));

    // Stop the chain-locked-height poller now that we've armed the proof.
    // The blockHeightPromise has already resolved.
    chainlockController.abort();
    chainlockController = null;

    const assetLockPrivateKeyWif = privateKeyToWif(
      state.assetLockKeyPair.privateKey,
      network
    );

    submissionStarted = true;
    console.log('[chainlock-fallback] submitting chain proof to Platform…');
    await runPlatformSubmission(proof, assetLockPrivateKeyWif);
    console.log('[chainlock-fallback] Platform submission resolved');
  } catch (error) {
    if (signal.aborted) {
      // Already transitioned to error via cancelChainlockFallback.
      return;
    }
    console.error('Chainlock fallback error:', error);
    // If runPlatformSubmission failed, let the step's natural error code apply
    // (REGISTER / TOPUP / SEND_ADDRESS) instead of masking it as CHAINLOCK.
    const errorCode = submissionStarted ? undefined : ErrorCodes.CHAINLOCK;
    updateState(setError(state, toError(error), errorCode));
  } finally {
    if (chainlockController?.signal === signal) {
      chainlockController = null;
    }
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
    const { extractDocumentSchemas, publishContract } = await loadContractModule();
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

    if (isE2EMockMode()) {
      await delay(60);
      updateState(setDpnsAvailability(state, createE2EMockDpnsAvailability(validUsernames)));
      return;
    }

    // Check availability for all valid usernames
    const { checkMultipleAvailability } = await loadDpnsModule();
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

    if (isE2EMockMode()) {
      const results = createE2EMockDpnsResults(availableUsernames);
      for (let i = 0; i < results.length; i++) {
        await delay(40);
        updateState(setDpnsRegistrationProgress(state, i));
      }
      await delay(40);
      updateState(setDpnsResults(state, results));
      return;
    }

    // Register all available usernames
    const { registerMultipleNames } = await loadDpnsModule();
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

    if (isE2EMockMode()) {
      await delay(80);
      updateState(setManageComplete(state, { success: true }));
      return;
    }

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
    const { updateIdentity } = await loadPlatformModule();
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

import { getNetwork, initNetworkRegistry, createCustomDevnetConfig, saveCustomDevnet, isReservedNetworkName, MAINNET, TESTNET } from './config.js';
import { publicKeyToAddress, signTransaction, generateKeyPair, validateCoreAddress, validatePlatformAddress } from './crypto/index.js';
import {
  formatCreditsAsDash,
  MIN_WITHDRAWAL_CREDITS,
  maxWithdrawableCredits,
  validateWithdrawalAmount,
} from './utils/credits.js';
import { extractErrorMessage } from './utils/errors.js';
import { parseKeyBackup } from './utils/key-backup.js';
import { deriveAssetLockKeyPair } from './crypto/hd.js';
import { createAssetLockTransaction, serializeTransaction, calculateTxId } from './transaction/index.js';
import { InsightClient, isAmbiguousBroadcastError } from './api/insight.js';
import type { IslockService } from './api/islock.js';
import { fetchNetworkStatus } from './api/network-status.js';
import { DAPIClient } from './api/dapi.js';
import { resolveDapiAddresses } from './api/evonodes.js';
import { buildInstantAssetLockProof, buildChainAssetLockProof } from './proof/index.js';
import { bech32m } from '@scure/base';
import { privateKeyToWif, bytesToHex, abortableSleep } from './utils/index.js';
import {
  createInitialState,
  setStep,
  setKeyPairs,
  setMode,
  setMobileAppRiskAcknowledged,
  continueInBrowserFromMobileAppRecommendation,
  getCurrentMobilePlatform,
  syncSmartAppBanner,
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
  isChainlockFallbackCancelled,
  setChainlockProgress,
  setChainlockProofReady,
  toError,
  ErrorCodes,
  setDepositTimedOut,
  setDepositVerificationFailed,
  setNetwork,
  updateIdentityKey,
  addIdentityKey,
  removeIdentityKey,
  render,
  refreshNetworkStatusTooltip,
  renderEmbedNotice,
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
  setManageActionKeys,
  setManageActionTransfer,
  setManageActionTopUp,
  setManageActionWithdraw,
  // Username transfer state functions
  setXferCredentialSource,
  setXferMnemonic,
  setXferDiscovering,
  setXferDiscoveryStatus,
  setXferCredentialError,
  setXferIdentityUnlocked,
  setXferSelectedUsername,
  setXferRecipientId,
  setXferRecipientChecking,
  setXferRecipientVerified,
  setXferRecipientError,
  setXferReview,
  setXferConfirmationAcknowledged,
  setXferTransferring,
  setXferResult,
  setXferBackToCredentials,
  setXferBackToSelect,
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
  // Withdraw state functions
  setWithdrawIdentityFetching,
  setWithdrawIdentityFetched,
  setWithdrawIdentityFetchError,
  setWithdrawKeyValidated,
  setWithdrawKeyValidationError,
  clearWithdrawKeyValidation,
  setWithdrawAddress,
  setWithdrawAmount,
  setWithdrawAmountError,
  setWithdrawSubmitting,
  setWithdrawSubmitted,
  setWithdrawSubmitError,
  setWithdrawOutcomeUnknown,
  setWithdrawOutcomeChecking,
  setWithdrawStatusUpdate,
  setWithdrawStatusNote,
  setWithdrawTrackingTimeout,
  setWithdrawBackToEntry,
  setWithdrawRetry,
  // Faucet state functions
  setFaucetSolvingPow,
  setFaucetRequesting,
  setFaucetSuccess,
  setFaucetError,
  // NEAR Intents state functions
  depositMinimumDuffs,
  setNearIntentsTabOpen,
  setNearIntentsTokensLoading,
  setNearIntentsTokens,
  setNearIntentsError,
  setNearIntentsPickerOpen,
  setNearIntentsAssetFilter,
  setNearIntentsOriginAsset,
  setNearIntentsAmount,
  setNearIntentsRefundAddress,
  setNearIntentsRefundError,
  setNearIntentsQuoting,
  clearNearIntentsQuote,
  setNearIntentsQuote,
  setNearIntentsConfirming,
  setNearIntentsSwap,
  clearNearIntentsSwap,
  nearChainName,
} from './ui/index.js';
import {
  getFaucetStatus,
  solveCap,
  requestTestnetFunds,
} from './api/faucet.js';
import {
  fetchNearIntentsTokens,
  formatUnits,
  getNearSwapStatus,
  isNearOutputDropTooLarge,
  isNearPriceIncreaseTooLarge,
  NearIntentsError,
  parseUnits,
  requestNearIntentsQuote,
  validateRefundAddress,
  type NearQuoteRequest,
} from './api/near-intents.js';
import { pollNearSwap } from './ui/near-swap-poll.js';
import { createNetworkStatusSync } from './ui/network-status-sync.js';
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
  loadPlatformForFunding,
  loadUsernameTransferModule,
  warmDashModules,
  warmPlatformSdkForFunding,
} from './platform/loaders.js';
import { ChunkLoadError, createChunkLoader } from './platform/chunk-loader.js';
import {
  deriveCandidateKeys,
  explainKeyIneligibility,
  isProtocolVersionBlocked,
  isValidIdentityId,
  isValidMnemonic,
  isWellFormedIdentityId,
  normalizeMnemonic,
  selectTransferSigningKey,
  MIN_TRANSFER_PROTOCOL_VERSION,
  type SigningKeySelection,
} from './platform/username-transfer-utils.js';
import {
  WithdrawalStatus,
  classifyWithdrawalLookups,
  type WithdrawalLandedOutcome,
  type WithdrawalLookupResult,
} from './platform/withdrawal-status.js';
import type {
  BridgeState,
  BridgeStep,
  KeyType,
  KeyPurpose,
  SecurityLevel,
  UTXO,
  AuthenticatedUtxo,
  ManageNewKeyConfig,
  DpnsUsernameEntry,
  DpnsRegistrationResult,
  IdentityPublicKeyInfo,
  OwnedUsername,
  E2EMockWindow,
  AssetLockProofData,
} from './types.js';
import type { AddKeyConfig } from './platform/index.js';
import {
  E2E_MOCK_DPNS_WIF,
  E2E_MOCK_IDENTITY_ID,
  E2E_MOCK_MANAGE_WIF,
  E2E_MOCK_WITHDRAW_WIF,
  E2E_MOCK_WITHDRAW_BALANCE,
  E2E_MOCK_XFER_MNEMONIC,
  E2E_MOCK_XFER_RECIPIENT_ID,
  E2E_MOCK_LOGIN_PUBLIC_KEYS,
} from './e2e-mock-constants.js';
import { resolveEmbed, type EmbedSession } from './embed/bridge.js';
import {
  setLoginInput,
  toggleLoginShowWif,
  setLoginVerifying,
  setLoginError,
  setLoginReview,
  setLoginBackToInput,
  setLoginComplete,
  setLoginCancelled,
} from './ui/state.js';
import {
  LoginAttempts,
  checkLoginKey,
  describeLoginFetchError,
  signLogin,
  validateLoginWif,
} from './platform/login.js';
import { hexToBytes } from './utils/hex.js';

// Global state
let state: BridgeState;
/** Set when a third-party app opened the bridge (create an identity, or sign in). */
let embedSession: EmbedSession | undefined;
let insightClient: InsightClient;
let islockService: IslockService | undefined;
let clientInitPromise: Promise<void> | undefined;
let warmupScheduled = false;
let warmupStarted = false;

async function initClients(network: string): Promise<void> {
  const config = getNetwork(network);
  insightClient = new InsightClient(config);
  // Testnet evonodes (and their certificates) rotate within days, so use the
  // live list; the static one in config.ts is the fallback.
  const [{ IslockService }, dapiAddresses] = await Promise.all([
    loadIslockModule(),
    resolveDapiAddresses(config),
  ]);
  // The evonode fetch can take seconds. If the user switched networks meanwhile,
  // the newer init owns the clients; installing these would pair this network's
  // IS-lock service with the other network's Insight client.
  if (state.network !== network) return;
  islockService = new IslockService({
    network,
    rpcUrl: config.rpcUrl,
    dapiAddresses,
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

/** How long a funding flow waits for the testnet SDK connect before showing its deposit address anyway. */
const FUNDING_SDK_CONNECT_WAIT_MS = 5000;

/**
 * Gate in front of every funding flow's deposit address (shown as "Preparing
 * Dash Platform..."). Loads the chunks the Platform submission needs, with
 * retries, so that once funds are committed nothing depends on a download;
 * when they still fail this throws a ChunkLoadError while nothing is at risk
 * (error screen with Reload).
 *
 * Testnet also starts connecting the SDK, so the health indicator reads
 * Platform before the asset lock is broadcast (polls right after the connect
 * settles instead of waiting for the next 30 s tick). The flow waits for that
 * connect at most FUNDING_SDK_CONNECT_WAIT_MS; it continues in the background
 * and a failure stays a health-indicator matter, as before.
 */
async function preparePlatformForFunding(): Promise<void> {
  // Mock-mode flows must not touch the network.
  if (isE2EMockMode()) {
    await loadE2EMockPlatform();
    return;
  }
  await loadPlatformForFunding();
  const connect = warmPlatformSdkForFunding(state.network).then((attempted) => {
    if (attempted) pollNetworkStatusNow?.();
  });
  await Promise.race([connect, delay(FUNDING_SDK_CONNECT_WAIT_MS)]);
}

// ── Network-status polling ──────────────────────────────────────────────────
// Periodically compares Core (Insight) height against Platform (DAPI) status
// so the header can warn when Platform consensus stalls while Core keeps
// moving. Re-renders only when the health verdict (or its reasons) changes, to
// avoid disrupting the UI on every tick.
const NETWORK_STATUS_POLL_MS = 30_000;
let networkStatusTimer: ReturnType<typeof setInterval> | undefined;
let networkStatusGeneration = 0;
let pollNetworkStatusNow: (() => void) | undefined;
const networkStatusSync = createNetworkStatusSync({
  getState: () => state,
  setStateQuietly: (next) => {
    state = next;
  },
  updateState: (next) => updateState(next),
  refreshTooltip: (status) => refreshNetworkStatusTooltip(document, status),
});

function stopNetworkStatusPolling(): void {
  if (networkStatusTimer !== undefined) {
    clearInterval(networkStatusTimer);
    networkStatusTimer = undefined;
  }
  // Bump the generation so any in-flight fetch result is ignored.
  networkStatusGeneration += 1;
  pollNetworkStatusNow = undefined;
  networkStatusSync.reset();
}

function startNetworkStatusPolling(): void {
  if (!insightClient || !islockService) return;
  stopNetworkStatusPolling();
  const generation = networkStatusGeneration;
  const insight = insightClient;
  const islock = islockService;
  const network = state.network;

  // Polls can overlap (the extra poll after the SDK connects); a slower, older
  // one must not overwrite the result of a newer one.
  let issued = 0;
  let applied = 0;

  const poll = async (): Promise<void> => {
    const sequence = ++issued;
    try {
      const status = await fetchNetworkStatus(insight, islock);
      // Ignore results from a superseded network/client.
      if (generation !== networkStatusGeneration) return;
      if (sequence < applied) return;
      applied = sequence;

      networkStatusSync.apply(network, status);
    } catch (err) {
      console.warn('Network status poll failed:', err);
    }
  };

  void poll();
  pollNetworkStatusNow = () => void poll();
  networkStatusTimer = setInterval(() => void poll(), NETWORK_STATUS_POLL_MS);
}

function switchNetwork(network: string): void {
  // Tear down any active IS lock subscriptions/polling before replacing clients
  if (islockService) {
    islockService.disconnect().catch((err) => console.warn('Error disconnecting IslockService:', err));
  }
  // The previous network's health snapshot must not sit under the new network's
  // badge until the next poll; the old poller's late results are ignored (see
  // createNetworkStatusSync.apply).
  updateState({ ...setNetwork(state, network), networkStatus: undefined });
  syncSmartAppBanner(document, network);
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

/**
 * Failure injection for mock-mode e2e tests, set with page.addInitScript:
 * `sdkLoadFailures` failed SDK chunk loads before the gate's loader succeeds
 * (3 or more exhausts its retries), `submissionFailures` failed Platform
 * submissions after the InstantSend lock arrived.
 */
interface E2EMockFailures {
  sdkLoadFailures?: number;
  submissionFailures?: number;
}

function e2eMockFailures(): E2EMockFailures {
  const w = window as typeof window & { __e2eMockFailures?: E2EMockFailures };
  w.__e2eMockFailures ??= {};
  return w.__e2eMockFailures;
}

const mockImportFailure = () => new TypeError('Importing a module script failed.');

// The real retrying loader around a fake import, so the e2e suite exercises
// its retries and error.
const loadE2EMockPlatform = createChunkLoader('evo-sdk', null, async () => {
  const failures = e2eMockFailures();
  if ((failures.sdkLoadFailures ?? 0) > 0) {
    failures.sdkLoadFailures! -= 1;
    throw mockImportFailure();
  }
  return {};
});

async function runE2EMockSubmission(): Promise<void> {
  await delay(120);
  const failures = e2eMockFailures();
  if ((failures.submissionFailures ?? 0) > 0) {
    failures.submissionFailures! -= 1;
    throw new ChunkLoadError('evo-sdk', 3, mockImportFailure());
  }
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

/** Mock identity for Sign in with Dash: real keys, so mock logins verify. */
function createE2EMockLoginKeys(identityId: string): IdentityPublicKeyInfo[] {
  if (identityId !== E2E_MOCK_IDENTITY_ID) throw new Error('Identity not found');
  return E2E_MOCK_LOGIN_PUBLIC_KEYS.map((key) => ({ ...key, data: hexToBytes(key.data), isDisabled: false }));
}

function createE2EMockOwnedUsernames(): OwnedUsername[] {
  // Both labels contain "l", which homograph-folds to "1" in normalizedLabel.
  // Real names like these cannot be resolved from their display form, so the
  // mock keeps the flow honest about carrying document ids around.
  return [
    { username: 'mocklabel.dash', documentId: E2E_MOCK_IDENTITY_ID, ownerId: E2E_MOCK_IDENTITY_ID },
    { username: 'second-mocklabel.dash', documentId: E2E_MOCK_XFER_RECIPIENT_ID, ownerId: E2E_MOCK_IDENTITY_ID },
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

  const container = document.getElementById('app');

  // Embed mode / framing guard: may refuse to run at all.
  const embed = resolveEmbed(window);
  if (embed.action === 'block') {
    if (container) renderEmbedNotice(container, embed.notice);
    return;
  }
  embedSession = embed.session;
  if (embedSession) {
    const session = embedSession;
    window.addEventListener('pagehide', () => session.handlePageHide());
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      session.expire();
      updateState(state);
    });
  }

  // Embed mode goes straight to create; deep links are for standalone use.
  state = embedSession ? applyEmbed(createInitialState(embedSession.network)) : stateFromUrl();
  syncSmartAppBanner(document, state.network);

  // Render UI
  if (container) {
    render(state, container);
    setupEventListeners(container);
  }

  embedSession?.start(state);
  scheduleDashWarmup();
}

/** Initial standalone state, honoring ?network=, ?address= and ?mode= deep links. */
function stateFromUrl(): BridgeState {
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

  let initial = createInitialState(network);

  // Deep-link: ?address=<bech32m> opens send-to-address mode with address pre-filled
  if (addressParam && validatePlatformAddress(addressParam, getNetwork(network))) {
    initial = setMode(initial, 'send_to_address');
    initial = setRecipientPlatformAddress(initial, addressParam);
  }

  // Deep-link: ?mode=contract opens contract registration mode
  const modeParam = urlParams.get('mode');
  if (modeParam === 'contract') {
    initial = setMode(initial, 'contract');
    const contractParam = urlParams.get('contract');
    if (contractParam) {
      void hydrateContractDeepLink(contractParam);
    }
  } else if (modeParam === 'withdraw') {
    // Deep-link: ?mode=withdraw opens credit withdrawal mode
    initial = setMode(initial, 'withdraw');
  }

  return initial;
}

/**
 * In embed mode, keep the embed context on every state and send any return
 * to the landing screen (Start Over, Try Again) back into the create flow.
 */
function applyEmbed(next: BridgeState): BridgeState {
  if (!embedSession) return next;
  const withEmbed = next.embed ? next : { ...next, embed: embedSession.display };
  if (withEmbed.step !== 'init') return withEmbed;
  return setMode(withEmbed, embedSession.display.request === 'login' ? 'login' : 'create');
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
  const prevState = state;
  const previousStep = prevState?.step;
  // A flow reset builds a fresh state without the health snapshot; keep the last one.
  state = applyEmbed(networkStatusSync.carryOver(newState));
  const container = document.getElementById('app');
  // Embed request cancelled or expired: the flow UI stays replaced.
  if (embedSession?.notice) {
    if (container) renderEmbedNotice(container, embedSession.notice);
    return;
  }
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

    // On a phone, land on the store button when the DashPay recommendation first appears.
    if (state.step === 'mobile_app_recommended' && previousStep !== 'mobile_app_recommended') {
      window.scrollTo(0, 0);
      if (getCurrentMobilePlatform() !== 'desktop') {
        // preventScroll keeps the "more secure" explanation in view on short screens.
        document.getElementById('mobile-app-primary-cta')?.focus({ preventScroll: true });
      }
    }
  }

  // Single hook for embed progress/result messages (all setIdentityRegistered
  // call sites land here).
  embedSession?.onStateChange(prevState, state);
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

  // Embed mode: Cancel (banner, and the login screens) and Return to app (complete screen)
  const cancelEmbed = () => {
    if (!embedSession?.cancel(state)) return;
    if (state.mode === 'login') {
      loginAttempts.next();
      updateState(setLoginCancelled(state));
    } else {
      updateState(state);
    }
  };
  container.querySelector('#embed-cancel-btn')?.addEventListener('click', cancelEmbed);
  container.querySelector('#login-cancel-btn')?.addEventListener('click', cancelEmbed);
  container.querySelector('#embed-return-btn')?.addEventListener('click', () => {
    embedSession?.returnToApp();
  });

  // Sign in with Dash
  const loginIdentityInput = container.querySelector<HTMLInputElement>('#login-identity-input');
  const loginWifInput = container.querySelector<HTMLInputElement>('#login-wif-input');
  loginIdentityInput?.addEventListener('input', () => {
    updateState(setLoginInput(state, { identityId: loginIdentityInput.value }));
  });
  loginWifInput?.addEventListener('input', () => {
    updateState(setLoginInput(state, { privateKeyWif: loginWifInput.value }));
  });
  for (const input of [loginIdentityInput, loginWifInput]) {
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void startLoginVerification();
    });
  }
  container.querySelector('#login-wif-toggle')?.addEventListener('click', () => {
    updateState(toggleLoginShowWif(state));
  });
  container.querySelector('#login-continue-btn')?.addEventListener('click', () => {
    void startLoginVerification();
  });
  container.querySelector('#login-back-btn')?.addEventListener('click', () => {
    loginAttempts.next();
    updateState(setLoginBackToInput(state));
  });
  container.querySelector('#login-sign-btn')?.addEventListener('click', () => {
    void approveLogin();
  });

  // Mode selection buttons (init page)
  const modeCreateBtn = container.querySelector('#mode-create-btn');
  attachDashWarmup(modeCreateBtn);
  if (modeCreateBtn) {
    modeCreateBtn.addEventListener('click', () => {
      updateState(setMode(state, 'create'));
    });
  }

  // Mainnet DashPay app recommendation: risk acknowledgement + continue in browser
  const mobileAppAckCheckbox = container.querySelector('#mobile-app-ack-checkbox') as HTMLInputElement | null;
  if (mobileAppAckCheckbox) {
    mobileAppAckCheckbox.addEventListener('change', () => {
      updateState(setMobileAppRiskAcknowledged(state, mobileAppAckCheckbox.checked));
    });
  }

  const mobileAppContinueBtn = container.querySelector('#mobile-app-continue-browser-btn');
  if (mobileAppContinueBtn) {
    mobileAppContinueBtn.addEventListener('click', () => {
      updateState(continueInBrowserFromMobileAppRecommendation(state));
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
        updateState({ ...state, mode: 'contract', step: 'contract_review', fromManageMenu: undefined });
      } else if (state.fromManageMenu) {
        // Opened from the Manage Identity menu, so go back to it rather than
        // all the way out. setMode('manage') is the menu.
        updateState(setMode(state, 'manage'));
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
      if (address && validatePlatformAddress(address, getNetwork(state.network))) {
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

  // NEAR Intents tab (mainnet deposit screen)
  container.querySelector('#deposit-tab-dash')?.addEventListener('click', () => {
    if (state.nearIntents?.open) updateState(setNearIntentsTabOpen(state, false));
  });
  container.querySelector('#deposit-tab-near')?.addEventListener('click', () => {
    if (state.nearIntents?.open) return;
    updateState(setNearIntentsTabOpen(state, true));
    void loadNearIntentsTokens();
  });
  container.querySelector('#near-tokens-retry-btn')?.addEventListener('click', () => {
    void loadNearIntentsTokens();
  });
  container.querySelector('#near-asset-btn')?.addEventListener('click', () => {
    updateState(setNearIntentsPickerOpen(state, true));
    (document.getElementById('near-asset-filter') as HTMLInputElement | null)?.focus();
  });
  container.querySelector('#near-picker-close')?.addEventListener('click', () => {
    updateState(setNearIntentsPickerOpen(state, false));
    resumeNearQuote();
  });
  const assetFilter = container.querySelector('#near-asset-filter');
  assetFilter?.addEventListener('input', (e) => {
    updateState(setNearIntentsAssetFilter(state, (e.target as HTMLInputElement).value));
  });
  assetFilter?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Escape') return;
    updateState(setNearIntentsPickerOpen(state, false));
    resumeNearQuote();
  });
  container.querySelectorAll<HTMLElement>('.near-token-option').forEach((option) => {
    option.addEventListener('click', () => {
      updateState(setNearIntentsOriginAsset(state, option.dataset.assetId ?? ''));
      scheduleNearQuote(0);
    });
  });
  for (const side of ['in', 'out'] as const) {
    container.querySelector(`#near-amount-${side}`)?.addEventListener('input', (e) => {
      updateState(setNearIntentsAmount(state, side, (e.target as HTMLInputElement).value));
      scheduleNearQuote();
    });
  }
  container.querySelector('#near-use-min-btn')?.addEventListener('click', () => {
    const near = state.nearIntents;
    if (!near?.minimumInput) return;
    updateState(setNearIntentsAmount(state, near.amountSide, near.minimumInput));
    scheduleNearQuote(0);
  });
  container.querySelector('#near-refund-input')?.addEventListener('input', (e) => {
    // Only re-render to clear an error on screen; typing needs no other update.
    const next = setNearIntentsRefundAddress(state, (e.target as HTMLInputElement).value);
    if (state.nearIntents?.refundError) updateState(next);
    else state = next;
  });
  container.querySelector('#near-confirm-btn')?.addEventListener('click', () => {
    void confirmNearSwap();
  });
  container.querySelector('#near-swap-reset-btn')?.addEventListener('click', () => {
    stopNearSwapPolling();
    updateState(clearNearIntentsSwap(state));
    scheduleNearQuote(0);
  });

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

  // Retry the Platform submission with the lock already received (offered on
  // the error screen when the submission failed after the lock arrived)
  const retryRegistrationBtn = container.querySelector('#retry-registration-btn');
  if (retryRegistrationBtn) {
    retryRegistrationBtn.addEventListener('click', () => {
      void retryPlatformSubmission();
    });
  }

  // Reload (offered when a required chunk failed to load before any deposit
  // address was shown, so nothing is lost by reloading)
  container.querySelector('#reload-page-btn')?.addEventListener('click', () => {
    window.location.reload();
  });

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

  // Manage action chooser (keys vs username transfer)
  const manageActionTopUpBtn = container.querySelector('#manage-action-topup-btn');
  attachDashWarmup(manageActionTopUpBtn);
  if (manageActionTopUpBtn) {
    manageActionTopUpBtn.addEventListener('click', () => {
      updateState(setManageActionTopUp(state));
    });
  }

  const manageActionWithdrawBtn = container.querySelector('#manage-action-withdraw-btn');
  attachDashWarmup(manageActionWithdrawBtn);
  if (manageActionWithdrawBtn) {
    manageActionWithdrawBtn.addEventListener('click', () => {
      updateState(setManageActionWithdraw(state));
    });
  }

  const manageActionKeysBtn = container.querySelector('#manage-action-keys-btn');
  if (manageActionKeysBtn) {
    manageActionKeysBtn.addEventListener('click', () => {
      updateState(setManageActionKeys(state));
    });
  }

  const manageActionTransferBtn = container.querySelector('#manage-action-transfer-btn');
  if (manageActionTransferBtn) {
    manageActionTransferBtn.addEventListener('click', () => {
      updateState(setManageActionTransfer(state));
    });
  }

  // Manage back button (various steps)
  const manageBackBtn = container.querySelector('#manage-back-btn');
  if (manageBackBtn) {
    manageBackBtn.addEventListener('click', () => {
      switch (state.step) {
        case 'manage_enter_identity':
          updateState(setStep(state, 'manage_choose_action'));
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
  // Username Transfer Event Listeners
  // ============================================================================

  // Credential source tabs
  const xferSourceSeedBtn = container.querySelector('#xfer-source-seed-btn');
  if (xferSourceSeedBtn) {
    xferSourceSeedBtn.addEventListener('click', () => {
      updateState(setXferCredentialSource(state, 'seed'));
    });
  }

  const xferSourceKeyBtn = container.querySelector('#xfer-source-key-btn');
  if (xferSourceKeyBtn) {
    xferSourceKeyBtn.addEventListener('click', () => {
      updateState(setXferCredentialSource(state, 'key'));
    });
  }

  // Seed phrase input — kept in state so it survives re-renders
  const xferMnemonicInput = container.querySelector('#xfer-mnemonic-input');
  if (xferMnemonicInput) {
    xferMnemonicInput.addEventListener('input', (e) => {
      const target = e.target as HTMLTextAreaElement;
      updateState(setXferMnemonic(state, target.value));
    });
  }

  // Unlock button
  const xferUnlockBtn = container.querySelector('#xfer-unlock-btn');
  if (xferUnlockBtn) {
    xferUnlockBtn.addEventListener('click', () => {
      if (!state.xferDiscoveryStatus) {
        startXferUnlock();
      }
    });
  }

  // Transfer back button (various steps)
  const xferBackBtn = container.querySelector('#xfer-back-btn');
  if (xferBackBtn) {
    xferBackBtn.addEventListener('click', () => {
      switch (state.step) {
        case 'xfer_credentials':
          updateState(setStep(state, 'manage_choose_action'));
          break;
        case 'xfer_select_username':
          updateState(setXferBackToCredentials(state));
          break;
        case 'xfer_review':
          updateState(setXferBackToSelect(state));
          break;
        default:
          updateState(setStep(state, 'init'));
      }
    });
  }

  // Username selection
  container.querySelectorAll('.xfer-username-radio').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      const username = target.dataset.username;
      if (username) {
        updateState(setXferSelectedUsername(state, username));
      }
    });
  });

  // Destination identity input — verify on blur or paste
  // Deliberately no 'input' listener: this app re-renders the whole tree on any
  // state change, so updating state per keystroke tears the field out from
  // under the user (and under any automation) mid-edit. Verify on blur/paste
  // instead, matching the identity inputs in the DPNS and manage flows.
  const xferRecipientInput = container.querySelector('#xfer-recipient-input');
  if (xferRecipientInput) {
    const verifyRecipient = () => {
      const recipientId = (xferRecipientInput as HTMLInputElement).value.trim();
      if (!recipientId || state.xferRecipientChecking) return;
      if (recipientId === state.xferRecipientId && state.xferRecipientVerified !== undefined) return;
      startXferRecipientCheck(recipientId);
    };

    xferRecipientInput.addEventListener('blur', verifyRecipient);
    xferRecipientInput.addEventListener('paste', () => {
      setTimeout(verifyRecipient, 50);
    });
  }

  // Continue to the confirmation screen
  const xferSelectContinueBtn = container.querySelector('#xfer-select-continue-btn');
  if (xferSelectContinueBtn) {
    xferSelectContinueBtn.addEventListener('click', () => {
      const typed = (
        container.querySelector<HTMLInputElement>('#xfer-recipient-input')?.value ?? ''
      ).trim();

      // The field may have been edited after the check without ever blurring —
      // never carry a stale verification onto a different recipient. An emptied
      // field counts as a change too, so clearing it cannot silently advance
      // with the previously verified ID.
      if (typed !== state.xferRecipientId) {
        startXferRecipientCheck(typed);
        return;
      }

      if (state.xferSelectedUsername && state.xferRecipientVerified) {
        updateState(setXferReview(state));
      }
    });
  }

  // Irreversibility acknowledgement
  const xferConfirmCheckbox = container.querySelector('#xfer-confirm-checkbox');
  if (xferConfirmCheckbox) {
    xferConfirmCheckbox.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      updateState(setXferConfirmationAcknowledged(state, target.checked));
    });
  }

  // Execute the transfer
  const xferTransferBtn = container.querySelector('#xfer-transfer-btn');
  if (xferTransferBtn) {
    xferTransferBtn.addEventListener('click', () => {
      if (state.xferConfirmationAcknowledged) {
        startUsernameTransfer();
      }
    });
  }

  // Transfer another username (restarts the sub-flow)
  const xferAgainBtn = container.querySelector('#xfer-again-btn');
  if (xferAgainBtn) {
    xferAgainBtn.addEventListener('click', () => {
      updateState(setManageActionTransfer(state));
    });
  }

  // Retry a failed transfer from the selection screen
  const xferRetryBtn = container.querySelector('#xfer-retry-btn');
  if (xferRetryBtn) {
    xferRetryBtn.addEventListener('click', () => {
      updateState(setXferBackToSelect(state));
    });
  }

  // ============================================================================
  // ============================================================================
  // Key Backup Upload Handlers (shared across DPNS, manage, contract)
  // ============================================================================

  function wireKeyUpload(
    inputId: string,
    onParsed: (result: { identityId: string; privateKeyWif: string }) => void,
    preferredPurpose?: string,
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
          const parsed = parseKeyBackup(json, preferredPurpose);
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

  // Username transfer key upload — fills in the identity ID + WIF, then unlocks
  wireKeyUpload('xfer-key-upload', async (result) => {
    updateState({
      ...setTargetIdentityId(state, result.identityId),
      xferPrivateKeyWif: result.privateKeyWif,
    });
    await guardXferUnlock(() => startXferUnlockFromKey(result.identityId, result.privateKeyWif));
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
  // Withdraw Event Listeners
  // ============================================================================

  // Withdraw key upload — prefer the TRANSFER key from the backup, fetch
  // identity + balance, validate, and land on the configure step in one shot
  wireKeyUpload('withdraw-key-upload', async (result) => {
    updateState(setWithdrawIdentityFetching(state, result.identityId));
    try {
      const [keys, identityState] = await Promise.all([
        getIdentityPublicKeys(result.identityId, state.network),
        getIdentityBalanceAndRevision(result.identityId, state.network),
      ]);
      let finalState = setWithdrawIdentityFetched(state, keys, BigInt(identityState.balance));
      const match = findMatchingKeyIndex(result.privateKeyWif, keys, state.network);
      if (match && match.purpose === 3 /* TRANSFER */) {
        finalState = setWithdrawKeyValidated(finalState, match.keyId, match.purpose, match.securityLevel, result.privateKeyWif);
      } else if (match) {
        finalState = {
          ...finalState,
          withdrawKeyValidationError: `The backup's ${getPurposeName(match.purpose)} key cannot sign withdrawals — a TRANSFER key is required.`,
        };
      } else {
        finalState = {
          ...finalState,
          withdrawKeyValidationError: 'No key in the backup matches this identity',
        };
      }
      updateState(finalState);
    } catch (error) {
      updateState(setWithdrawIdentityFetchError(state, error instanceof Error ? error.message : String(error)));
    }
  }, 'TRANSFER');

  // Withdraw mode button (init page)
  // Withdraw back button (enter identity / configure steps)
  const withdrawBackBtn = container.querySelector('#withdraw-back-btn');
  if (withdrawBackBtn) {
    withdrawBackBtn.addEventListener('click', () => {
      switch (state.step) {
        case 'withdraw_configure':
          updateState(setWithdrawBackToEntry(state));
          break;
        default:
          // ?mode=withdraw deep-links straight here, so only return to the
          // Manage Identity menu when that is where we came from.
          updateState(state.fromManageMenu ? setMode(state, 'manage') : setStep(state, 'init'));
      }
    });
  }

  // Wire the standard "validate on blur, and shortly after paste" input pattern.
  const onBlurOrPaste = (
    selector: string,
    handler: (input: HTMLInputElement) => void
  ): HTMLInputElement | null => {
    const input = container.querySelector<HTMLInputElement>(selector);
    if (!input) return null;
    const run = () => handler(input);
    input.addEventListener('blur', run);
    input.addEventListener('paste', () => setTimeout(run, 50));
    return input;
  };

  // Withdraw identity ID input - fetch identity + balance
  onBlurOrPaste('#withdraw-identity-id-input', async (input) => {
    const identityId = input.value.trim();

    if (!identityId || state.withdrawIdentityFetching) {
      return;
    }

    // Skip if this identity is already fetched — refetching would clear a
    // validated TRANSFER key and repeat two network calls for no change.
    if (state.targetIdentityId === identityId && state.withdrawIdentityKeys) {
      return;
    }

    if (!validateIdentityId(identityId)) {
      updateState(setWithdrawIdentityFetchError(state, 'Invalid identity ID format (expected 44 character Base58 string)'));
      return;
    }

    updateState(setWithdrawIdentityFetching(state, identityId));

    try {
      if (isE2EMockMode()) {
        await delay(30);
        updateState(setWithdrawIdentityFetched(state, createE2EMockIdentityKeys(), BigInt(E2E_MOCK_WITHDRAW_BALANCE)));
        return;
      }

      const [keys, identityState] = await Promise.all([
        getIdentityPublicKeys(identityId, state.network),
        getIdentityBalanceAndRevision(identityId, state.network),
      ]);
      updateState(setWithdrawIdentityFetched(state, keys, BigInt(identityState.balance)));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch identity';
      updateState(setWithdrawIdentityFetchError(state, message));
    }
  });

  // Withdraw private key input - must match a TRANSFER key on the identity
  onBlurOrPaste('#withdraw-private-key-input', (input) => {
    const privateKeyWif = input.value.trim();

    // The WIF is deliberately never rendered back into the DOM, so the field
    // is blank after every re-render. An empty blur is a no-op (a validated
    // key stays validated); entering a new key replaces the old one.
    if (!privateKeyWif) {
      if (!state.withdrawSigningKeyInfo && state.withdrawKeyValidationError) {
        updateState(clearWithdrawKeyValidation(state));
      }
      return;
    }

    if (!state.withdrawIdentityKeys || state.withdrawIdentityKeys.length === 0) {
      updateState(setWithdrawKeyValidationError(state, 'Please enter an identity ID first'));
      return;
    }

    if (isE2EMockMode()) {
      if (privateKeyWif === E2E_MOCK_WITHDRAW_WIF) {
        updateState(setWithdrawKeyValidated(state, 3, 3, 1, privateKeyWif));
      } else {
        updateState(setWithdrawKeyValidationError(state, 'Mock mode: use the configured test private key'));
      }
      return;
    }

    const match = findMatchingKeyIndex(privateKeyWif, state.withdrawIdentityKeys, state.network);

    if (!match) {
      updateState(setWithdrawKeyValidationError(state, 'This key does not match any key registered with this identity'));
      return;
    }

    // Withdrawals to an address must be signed with a TRANSFER key (purpose 3).
    // OWNER keys are rejected by consensus when a destination address is set.
    if (match.purpose !== 3) {
      const purposeName = getPurposeName(match.purpose);
      updateState(setWithdrawKeyValidationError(
        state,
        `This key has ${purposeName} purpose. Withdrawals must be signed with a TRANSFER key (identities created by this bridge have one at HD index 3).`
      ));
      return;
    }

    updateState(setWithdrawKeyValidated(state, match.keyId, match.purpose, match.securityLevel, privateKeyWif));
  });

  // Withdraw destination address input
  onBlurOrPaste('#withdraw-address-input', (input) => {
    const address = input.value.trim();

    if (!address) {
      updateState(setWithdrawAddress(state, ''));
      return;
    }

    const result = validateCoreAddress(address, getNetwork(state.network));
    updateState(setWithdrawAddress(state, address, result.valid ? undefined : result.error || 'Invalid address'));
  });

  // Withdraw amount input
  const withdrawAmountInput = onBlurOrPaste('#withdraw-amount-input', (input) => {
    const raw = input.value.trim();

    if (!raw) {
      updateState(setWithdrawAmountError(state, '', ''));
      return;
    }

    const result = validateWithdrawalAmount(raw, state.withdrawBalance ?? 0n);
    if ('error' in result) {
      updateState(setWithdrawAmountError(state, raw, result.error));
    } else {
      updateState(setWithdrawAmount(state, result.credits, raw));
    }
  });

  // Max button: fill with balance minus a reserve for the Platform transition fee
  if (withdrawAmountInput) {
    const withdrawMaxBtn = container.querySelector('#withdraw-max-btn');
    if (withdrawMaxBtn) {
      withdrawMaxBtn.addEventListener('click', () => {
        const max = maxWithdrawableCredits(state.withdrawBalance ?? 0n);
        if (max < MIN_WITHDRAWAL_CREDITS) {
          updateState(setWithdrawAmountError(state, '', `Balance is too small to withdraw (minimum ${formatCreditsAsDash(MIN_WITHDRAWAL_CREDITS)} DASH plus fees)`));
          return;
        }
        const raw = formatCreditsAsDash(max);
        withdrawAmountInput.value = raw;
        updateState(setWithdrawAmount(state, max, raw));
      });
    }
  }

  // Withdraw submit button
  const withdrawSubmitBtn = container.querySelector('#withdraw-submit-btn');
  if (withdrawSubmitBtn) {
    withdrawSubmitBtn.addEventListener('click', () => {
      startWithdrawal();
    });
  }

  // Withdraw tracking: leave polling but keep the success result
  const withdrawTrackingDoneBtn = container.querySelector('#withdraw-tracking-done-btn');
  if (withdrawTrackingDoneBtn) {
    withdrawTrackingDoneBtn.addEventListener('click', () => {
      updateState(setWithdrawTrackingTimeout(
        state,
        'Your withdrawal was accepted and continues processing on the network. The payout will arrive at the destination address; check your Core wallet.'
      ));
    });
  }

  // Withdraw complete: retry / start over
  const withdrawRetryBtn = container.querySelector('#withdraw-retry-btn');
  if (withdrawRetryBtn) {
    withdrawRetryBtn.addEventListener('click', () => {
      updateState(setWithdrawRetry(state));
    });
  }

  // Withdraw outcome unknown: re-run the landed check (no retry offered)
  const withdrawCheckAgainBtn = container.querySelector('#withdraw-check-again-btn');
  if (withdrawCheckAgainBtn) {
    withdrawCheckAgainBtn.addEventListener('click', () => {
      void recheckWithdrawalOutcome();
    });
  }

  const withdrawStartOverBtn = container.querySelector('#withdraw-start-over-btn');
  if (withdrawStartOverBtn) {
    withdrawStartOverBtn.addEventListener('click', () => {
      updateState(setStep(state, 'init'));
    });
  }

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

// ============================================================================
// Sign in with Dash
// ============================================================================

/**
 * Bumped by Continue, Sign in, Back and Cancel. Every await in the login flow
 * re-checks its token, so a stale fetch or signature never lands on a newer
 * screen (or after Cancel).
 */
const loginAttempts = new LoginAttempts();

/** Re-read after an await (TypeScript keeps the pre-await narrowing of `state`). */
function isCurrentLogin(token: number, step: BridgeStep): boolean {
  return loginAttempts.isCurrent(token) && state.step === step;
}

async function fetchLoginIdentityKeys(identityId: string): Promise<IdentityPublicKeyInfo[]> {
  if (isE2EMockMode()) {
    await delay(30);
    return createE2EMockLoginKeys(identityId);
  }
  return getIdentityPublicKeys(identityId, state.network);
}

/** Continue: fetch the identity's keys and check the WIF matches one that may sign in. */
async function startLoginVerification(): Promise<void> {
  if (state.step !== 'login_input') return;
  const identityId = (state.loginIdentityId ?? '').trim();
  const privateKeyWif = (state.loginPrivateKeyWif ?? '').trim();
  if (!isWellFormedIdentityId(identityId)) {
    updateState(setLoginError(state, 'Enter a valid identity ID (44-character Base58).'));
    return;
  }
  const wifError = validateLoginWif(privateKeyWif, state.network);
  if (wifError) {
    updateState(setLoginError(state, wifError));
    return;
  }

  const token = loginAttempts.next();
  updateState(setLoginVerifying(setLoginInput(state, { identityId, privateKeyWif })));
  try {
    const keys = await fetchLoginIdentityKeys(identityId);
    if (!isCurrentLogin(token, 'login_verifying')) return; // cancelled meanwhile
    const check = checkLoginKey(privateKeyWif, keys, state.network);
    updateState(check.ok ? setLoginReview(state, check.key) : setLoginError(state, check.error));
  } catch (error) {
    if (!isCurrentLogin(token, 'login_verifying')) return;
    updateState(setLoginError(state, describeLoginFetchError(error, state.network)));
  }
}

/** Sign in: sign the login message, drop the WIF, and hand the result to the app. */
async function approveLogin(): Promise<void> {
  const session = embedSession;
  const login = session?.login;
  const { loginKey, loginIdentityId, loginPrivateKeyWif } = state;
  if (state.step !== 'login_review' || !session || !login || !loginKey || !loginIdentityId || !loginPrivateKeyWif) {
    return;
  }
  const token = loginAttempts.next();
  try {
    const result = await signLogin({
      origin: session.origin,
      returnUrl: login.returnUrl,
      identityId: loginIdentityId,
      statement: login.statement,
      network: session.network,
      nonce: login.nonce,
      keyId: loginKey.keyId,
      privateKeyWif: loginPrivateKeyWif,
    });
    // Double click, Back, or Cancel while signing.
    if (!isCurrentLogin(token, 'login_review')) return;
    updateState(setLoginComplete(state));
    session.completeLogin(result);
  } catch (error) {
    if (!isCurrentLogin(token, 'login_review')) return;
    updateState(setLoginError(state, `Could not sign in: ${extractErrorMessage(error)}`));
  }
}

/**
 * Validate identity ID format (Base58, ~44 characters)
 */
function validateIdentityId(id?: string): boolean {
  return !!id && isValidIdentityId(id);
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
 * Authenticate a detected deposit before anything is built or signed: its
 * value and script are re-derived from the raw previous transaction (see
 * InsightClient.getAuthenticatedUtxo). On failure nothing has been signed, so
 * return to the deposit step with a recheck prompt (keys stay in state) and
 * resolve null; the caller must stop.
 */
async function authenticateDeposit(
  utxo: UTXO,
  depositPublicKey: Uint8Array
): Promise<AuthenticatedUtxo | null> {
  try {
    return await insightClient.getAuthenticatedUtxo(utxo, depositPublicKey);
  } catch (error) {
    console.error('Deposit verification failed:', error);
    updateState(setDepositVerificationFailed(state, toError(error).message));
    return null;
  }
}

/**
 * Start the top-up process
 */
/**
 * Broadcast a signed asset lock transaction.
 *
 * A broadcast that timed out may still have reached the node, so it is not a
 * failure: continue with the locally computed txid and let the IS lock wait
 * (and its chain-lock fallback, which needs `state.txid`) settle the outcome.
 * Definite rejections still throw.
 */
async function broadcastAssetLock(signedTxHex: string, txid: string): Promise<void> {
  try {
    const broadcastedTxid = await insightClient.broadcastTransaction(signedTxHex);
    if (broadcastedTxid !== txid) {
      console.warn(`Broadcast txid ${broadcastedTxid} differs from local ${txid}`);
    }
  } catch (error) {
    if (!isAmbiguousBroadcastError(error)) throw error;
    console.warn(`Broadcast outcome unknown for ${txid}; waiting for its lock instead:`, error);
  }
}

async function startTopUp() {
  try {
    if (isE2EMockMode()) {
      const network = getNetwork(state.network);
      const assetLockKeyPair = generateKeyPair();
      const depositAddress = publicKeyToAddress(assetLockKeyPair.publicKey, network);

      updateState(setStep(state, 'generating_keys'));
      await delay(120);
      await preparePlatformForFunding();
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
      await runE2EMockSubmission();
      updateState(setTopUpComplete(state));
      return;
    }

    updateState(setStep(state, 'generating_keys'));
    await ensureClients();
    await preparePlatformForFunding();
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

    const utxo = await authenticateDeposit(depositResult.utxo, assetLockKeyPair.publicKey);
    if (!utxo) return;

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
    await broadcastAssetLock(signedTxHex, txid);

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
    await preparePlatformForFunding();
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

    const utxo = await authenticateDeposit(depositResult.utxo, assetLockKeyPair.publicKey);
    if (!utxo) return;
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
    await broadcastAssetLock(signedTxHex, txid);
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
 * Resubmit the Platform operation (registration, top-up or send) with the
 * asset lock proof already in state. Offered on the error screen when the
 * submission failed after the lock arrived: the asset lock can only be
 * consumed once and the identity ID is deterministic, so resubmitting can't
 * spend the deposit twice or create a second identity.
 */
async function retryPlatformSubmission(): Promise<void> {
  if (!state.assetLockProof || !state.assetLockKeyPair) {
    console.error('Retry submission unavailable: missing asset lock proof or key');
    return;
  }
  try {
    const assetLockPrivateKeyWif = privateKeyToWif(
      state.assetLockKeyPair.privateKey,
      getNetwork(state.network)
    );
    await runPlatformSubmission(state.assetLockProof, assetLockPrivateKeyWif);
  } catch (error) {
    console.error('Retry submission error:', error);
    updateState(setError(state, toError(error)));
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
      await preparePlatformForFunding();
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
      await runE2EMockSubmission();
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
    await preparePlatformForFunding();
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

    const utxo = await authenticateDeposit(depositResult.utxo, assetLockKeyPair.publicKey);
    if (!utxo) return;

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
    await broadcastAssetLock(signedTxHex, txid);
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

    const { registerIdentityResilient } = await loadPlatformModule();
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

  // Continue with the rest of the bridge process
  try {
    const network = getNetwork(state.network);
    const assetLockKeyPair = state.assetLockKeyPair!;

    const utxo = await authenticateDeposit(depositResult.utxo, assetLockKeyPair.publicKey);
    if (!utxo) return;

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
    await broadcastAssetLock(signedTxHex, txid);
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
      const { registerIdentityResilient } = await loadPlatformModule();
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
  assetLockProof: AssetLockProofData,
  assetLockPrivateKeyWif: string
): Promise<void> {
  if (isE2EMockMode()) {
    updateState(setStep(state, state.mode === 'topup' ? 'topping_up' : 'registering_identity'));
    await runE2EMockSubmission();
    updateState(state.mode === 'topup' ? setTopUpComplete(state) : setIdentityRegistered(state, E2E_MOCK_IDENTITY_ID));
    return;
  }

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
    const { registerIdentityResilient } = await loadPlatformModule();
    const result = await registerIdentityResilient(
      assetLockProof,
      assetLockPrivateKeyWif,
      state.identityKeys,
      state.network
    );
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
 * confirming block, poll for the chain-locked tip (JSON-RPC on mainnet,
 * Platform status elsewhere), and once `coreChainLockedHeight >= blockHeight` build a
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

  // Poll #2: chain-locked Dash Core height. JSON-RPC `getbestchainlock`
  // first (it returns nothing without an rpcUrl, e.g. on testnet), then the
  // Platform status via IslockService: the EvoSDK on testnet, direct gRPC via
  // @dashevo/dapi-client elsewhere (it works uniformly across trusted and
  // non-trusted devnets; see DAPISubscriptionClient.getCoreChainLockedHeight).
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
    // The signal is aborted on purpose just before submitting (to stop the
    // height poller), so it only means "cancelled" while still waiting.
    if (isChainlockFallbackCancelled(signal.aborted, submissionStarted)) {
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
    const { publishContract } = await loadContractModule();

    const result = await publishContract(
      identityId,
      contractJson,
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
// Username Transfer Functions
// ============================================================================

/**
 * Load what the transfer flow needs once the identity and signing key are
 * known: the names it owns, and the network's protocol version.
 */
async function loadTransferContext(identityId: string): Promise<{
  usernames: OwnedUsername[];
  protocolVersion?: number;
}> {
  const { listOwnedUsernames, getProtocolVersion } = await loadUsernameTransferModule();

  const [usernames, protocolVersion] = await Promise.all([
    listOwnedUsernames(identityId, state.network),
    // Best-effort: a failed version read must not block the flow, it only
    // suppresses the "this network is too old" warning.
    getProtocolVersion(state.network).catch(() => undefined),
  ]);

  return { usernames, protocolVersion };
}

/**
 * Resolve the identity and signing key from a seed phrase, then load the
 * usernames it owns.
 */
async function startXferUnlockFromSeed(mnemonic: string) {
  if (!isValidMnemonic(mnemonic)) {
    updateState(setXferCredentialError(state, 'That is not a valid BIP39 seed phrase. Check for typos or missing words.'));
    return;
  }

  updateState(setXferDiscovering(state, 'Deriving keys from your seed phrase...'));

  if (isE2EMockMode()) {
    await unlockXferMock(
      E2E_MOCK_IDENTITY_ID,
      E2E_MOCK_DPNS_WIF,
      mnemonic === normalizeMnemonic(E2E_MOCK_XFER_MNEMONIC)
        ? undefined
        : 'Mock mode: use the configured test seed phrase'
    );
    return;
  }

  const candidates = deriveCandidateKeys(mnemonic, state.network);

  const { discoverIdentitiesFromCandidates } = await loadUsernameTransferModule();
  const discovered = await discoverIdentitiesFromCandidates(
    candidates,
    state.network,
    (checked: number, total: number) => {
      updateState(setXferDiscoveryStatus(state, `Searching for your identities (${checked}/${total})...`));
    }
  );

  if (discovered.length === 0) {
    updateState(setXferCredentialError(
      state,
      'No identity on this network uses a key from that seed phrase. Check you picked the right network, or use the Private Key tab to enter an identity ID directly.'
    ));
    return;
  }

  updateState(setXferDiscoveryStatus(
    state,
    discovered.length === 1
      ? 'Identity found. Checking your keys...'
      : `Found ${discovered.length} identities. Checking which own usernames...`
  ));

  // A seed commonly controls several identities, and the first one found is not
  // necessarily the one holding the name. Load each, then prefer one that
  // actually owns a username.
  const loaded: {
    identityId: string;
    selection: ReturnType<typeof selectTransferSigningKey>;
    usernames: OwnedUsername[];
    protocolVersion?: number;
  }[] = [];

  for (const { identityId } of discovered) {
    const keys = await getIdentityPublicKeys(identityId, state.network);
    const selection = selectTransferSigningKey(candidates, keys, state.network);
    const context = selection.status === 'ok'
      ? await loadTransferContext(identityId)
      : { usernames: [] as OwnedUsername[], protocolVersion: undefined };
    loaded.push({ identityId, selection, ...context });
  }

  const usable = loaded.filter((entry) => entry.selection.status === 'ok');
  if (usable.length === 0) {
    // Report the most informative failure we saw rather than a generic one.
    const ineligible = loaded.find((entry) => entry.selection.status === 'ineligible');
    await applyXferKeySelection(
      loaded[0].identityId,
      ineligible?.selection ?? loaded[0].selection,
      'That seed phrase does not control any active key on the identities it points to.'
    );
    return;
  }

  const chosen = usable.find((entry) => entry.usernames.length > 0) ?? usable[0];
  const selection = chosen.selection;
  if (selection.status !== 'ok') return; // narrowed by `usable` above

  updateState(setXferIdentityUnlocked(state, {
    identityId: chosen.identityId,
    privateKeyWif: selection.candidate.privateKeyWif,
    keyId: selection.keyId,
    securityLevel: selection.securityLevel,
    usernames: chosen.usernames,
    protocolVersion: chosen.protocolVersion,
    otherIdentities: usable
      .filter((entry) => entry.identityId !== chosen.identityId)
      .map((entry) => entry.identityId),
  }));
}

/**
 * Validate an identity ID + WIF pair, then load the usernames it owns.
 */
async function startXferUnlockFromKey(identityId: string, privateKeyWif: string) {
  if (!isValidIdentityId(identityId)) {
    updateState(setXferCredentialError(state, 'Invalid identity ID format (expected 44 character Base58 string)'));
    return;
  }

  if (!privateKeyWif) {
    updateState(setXferCredentialError(state, 'Enter the private key for this identity'));
    return;
  }

  updateState(setXferDiscovering(state, 'Fetching identity...'));

  if (isE2EMockMode()) {
    await unlockXferMock(
      identityId,
      privateKeyWif,
      privateKeyWif === E2E_MOCK_DPNS_WIF
        ? undefined
        : 'Mock mode: use the configured test private key'
    );
    return;
  }

  const keys = await getIdentityPublicKeys(identityId, state.network);
  await applyXferKeySelection(
    identityId,
    selectTransferSigningKey([{ privateKeyWif }], keys, state.network),
    'This key does not match any active key registered with this identity'
  );
}

/**
 * Shared tail of both unlock paths: report why the key cannot sign, or load the
 * identity's usernames and move on to selection.
 */
async function applyXferKeySelection(
  identityId: string,
  selection: SigningKeySelection<{ privateKeyWif: string }>,
  noMatchMessage: string
) {
  if (selection.status === 'no_match') {
    updateState(setXferCredentialError(state, noMatchMessage));
    return;
  }

  if (selection.status === 'ineligible') {
    updateState(setXferCredentialError(
      state,
      `${explainKeyIneligibility(selection.purpose, selection.securityLevel)} Use "Manage Keys" to add an AUTHENTICATION key with HIGH security level to this identity, then try again.`
    ));
    return;
  }

  updateState(setXferDiscoveryStatus(state, 'Loading your usernames...'));

  const { usernames, protocolVersion } = await loadTransferContext(identityId);

  updateState(setXferIdentityUnlocked(state, {
    identityId,
    privateKeyWif: selection.candidate.privateKeyWif,
    keyId: selection.keyId,
    securityLevel: selection.securityLevel,
    usernames,
    protocolVersion,
  }));
}

/**
 * Deterministic stand-in for identity discovery in Playwright mock mode.
 */
async function unlockXferMock(identityId: string, privateKeyWif: string, rejection?: string) {
  await delay(60);

  if (rejection) {
    updateState(setXferCredentialError(state, rejection));
    return;
  }

  updateState(setXferIdentityUnlocked(state, {
    identityId,
    privateKeyWif,
    keyId: 1,
    securityLevel: 2,
    usernames: createE2EMockOwnedUsernames(),
    protocolVersion: MIN_TRANSFER_PROTOCOL_VERSION,
  }));
}

/**
 * Run an unlock attempt, surfacing any failure on the credential screen rather
 * than leaving the user on a stuck spinner.
 */
async function guardXferUnlock(run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    console.error('Username transfer unlock error:', error);
    updateState(setXferCredentialError(state, toError(error).message));
  }
}

/**
 * Entry point for the "Continue" button on the credential screen.
 */
function startXferUnlock() {
  return guardXferUnlock(async () => {
    if ((state.xferCredentialSource ?? 'seed') === 'seed') {
      await startXferUnlockFromSeed(normalizeMnemonic(state.xferMnemonic || ''));
      return;
    }

    const identityId = (
      document.querySelector<HTMLInputElement>('#xfer-identity-id-input')?.value ?? ''
    ).trim();
    const privateKeyWif = (
      document.querySelector<HTMLInputElement>('#xfer-private-key-input')?.value ?? ''
    ).trim();

    await startXferUnlockFromKey(identityId, privateKeyWif);
  });
}

/**
 * Verify the destination identity exists before we let the user sign anything.
 *
 * Platform does not validate the recipient of a document transfer, so a
 * mistyped ID would move the username to an identity nobody controls.
 */
async function startXferRecipientCheck(recipientId: string) {
  // Record what is being checked before validating: it invalidates any earlier
  // verification, and keeps the typed value through the re-render (the field is
  // uncontrolled between blurs).
  updateState(setXferRecipientId(state, recipientId));

  if (!recipientId) {
    updateState(setXferRecipientError(state, 'Enter the identity ID to transfer the username to'));
    return;
  }

  if (!isWellFormedIdentityId(recipientId)) {
    updateState(setXferRecipientError(state, 'Invalid identity ID (expected a Base58 string decoding to 32 bytes)'));
    return;
  }

  if (recipientId === state.targetIdentityId) {
    updateState(setXferRecipientError(state, 'This is the identity that already owns the username'));
    return;
  }

  updateState(setXferRecipientChecking(state));

  try {
    if (isE2EMockMode()) {
      await delay(40);
      if (recipientId === E2E_MOCK_XFER_RECIPIENT_ID) {
        updateState(setXferRecipientVerified(state));
      } else {
        updateState(setXferRecipientError(state, 'Mock mode: use the configured test recipient identity'));
      }
      return;
    }

    const { identityExists } = await loadUsernameTransferModule();
    const exists = await identityExists(recipientId, state.network);

    if (exists) {
      updateState(setXferRecipientVerified(state));
    } else {
      updateState(setXferRecipientError(
        state,
        `No identity with this ID exists on ${state.network}. Transferring to it would lose the username permanently.`
      ));
    }
  } catch (error) {
    console.error('Recipient verification error:', error);
    updateState(setXferRecipientError(state, `Could not verify this identity: ${toError(error).message}`));
  }
}

/**
 * Sign and broadcast the username transfer.
 */
async function startUsernameTransfer() {
  const username = state.xferSelectedUsername;
  const identityId = state.targetIdentityId;
  const privateKeyWif = state.xferPrivateKeyWif;
  const recipientId = state.xferRecipientId;
  const keyId = state.xferSigningKeyInfo?.keyId;

  if (!username || !identityId || !privateKeyWif || !recipientId || keyId === undefined) {
    updateState(setXferResult(state, { success: false, error: 'Missing transfer details' }));
    return;
  }

  // The UI disables the button, but never sign a transition the network is
  // going to reject outright.
  if (isProtocolVersionBlocked(state.xferProtocolVersion)) {
    updateState(setXferResult(state, {
      success: false,
      error: `${state.network} runs protocol version ${state.xferProtocolVersion}; username transfers require version ${MIN_TRANSFER_PROTOCOL_VERSION} or later.`,
    }));
    return;
  }

  updateState(setXferTransferring(state));

  try {
    if (isE2EMockMode()) {
      await delay(80);
      updateState(setXferResult(state, { success: true, verifiedOwner: true, recordsUpdated: true }));
      return;
    }

    const selected = (state.xferOwnedUsernames || []).find((u) => u.username === username);
    if (!selected) {
      updateState(setXferResult(state, { success: false, error: `"${username}" is no longer in the list of names this identity owns` }));
      return;
    }

    const { transferUsername } = await loadUsernameTransferModule();
    const result = await transferUsername({
      username,
      documentId: selected.documentId,
      identityId,
      publicKeyId: keyId,
      privateKeyWif,
      recipientId,
      network: state.network,
    });

    updateState(setXferResult(state, result));
  } catch (error) {
    console.error('Username transfer error:', error);
    // WasmSdkError is not a standard Error, so check for message property
    updateState(setXferResult(state, { success: false, error: toError(error).message }));
  }
}

// ============================================================================
// Withdraw Functions
// ============================================================================

const WITHDRAW_POLL_INTERVAL_MS = 10_000;
const WITHDRAW_POLL_TIMEOUT_MS = 5 * 60_000;
const WITHDRAW_POLL_FAILURE_WARNING_THRESHOLD = 5;

async function startWithdrawal() {
  const identityId = state.targetIdentityId;
  const privateKeyWif = state.withdrawPrivateKeyWif;
  const amountCredits = state.withdrawAmountCredits;
  const toAddress = state.withdrawToAddress;

  if (!identityId || !privateKeyWif || amountCredits === undefined || !toAddress) {
    updateState(setWithdrawSubmitError(state, 'Missing withdrawal details'));
    return;
  }

  updateState(setWithdrawSubmitting(state));

  try {
    if (isE2EMockMode()) {
      await delay(80);
      e2eMockWithdrawChecks = readE2EMockWithdrawChecks();
      if (e2eMockWithdrawChecks) {
        // Scripted submission error; the landed checks replay the script.
        const sinceMs = Date.now();
        applyWithdrawalLandedOutcome(
          await checkWithdrawalLanded(identityId, sinceMs),
          identityId,
          sinceMs,
          'Mock submission error'
        );
        return;
      }
      const mockRemaining = BigInt(E2E_MOCK_WITHDRAW_BALANCE) - amountCredits;
      updateState(setWithdrawSubmitted(state, mockRemaining));
      // Deterministically walk the payout statuses to completion
      await delay(30);
      updateState(setWithdrawStatusUpdate(state, 1)); // POOLED
      await delay(30);
      updateState(setWithdrawStatusUpdate(state, 3)); // COMPLETE
      return;
    }

    // Capture before submitting so the withdrawal document (created when the
    // transition is processed) is matched even with modest clock skew.
    const sinceMs = Date.now() - 60_000;

    const { withdrawCredits } = await loadPlatformModule();
    const result = await withdrawCredits(
      identityId,
      privateKeyWif,
      amountCredits,
      toAddress,
      state.network
    );

    if (result.timedOut) {
      // Ambiguous outcome: the transition may already be broadcast, so a
      // "failed" screen here would invite a double spend via retry. Track
      // instead — the withdrawal document will show up if it went through.
      updateState(setWithdrawStatusNote(
        setWithdrawSubmitted(state),
        'Confirmation timed out, but the withdrawal may still have been submitted — checking the network for it. Do not retry until the outcome is clear.'
      ));
      void pollWithdrawalStatus(identityId, sinceMs);
      return;
    }

    if (!result.success || result.remainingBalance === undefined) {
      // A non-timeout error can still have occurred AFTER broadcast (e.g.
      // while waiting for the state transition result). Before offering a
      // retryable failure screen, check whether the withdrawal actually
      // landed — a second submission would withdraw twice.
      applyWithdrawalLandedOutcome(
        await checkWithdrawalLanded(identityId, sinceMs),
        identityId,
        sinceMs,
        result.error || 'Withdrawal failed'
      );
      return;
    }

    updateState(setWithdrawSubmitted(state, result.remainingBalance));
    void pollWithdrawalStatus(identityId, sinceMs);
  } catch (error) {
    console.error('Withdrawal error:', error);
    updateState(setWithdrawSubmitError(state, extractErrorMessage(error)));
  }
}

/**
 * E2E mock: scripted landed-check verdicts consumed in order, e.g.
 * `?e2e=mock&e2eWithdrawChecks=unknown,found`. When present, the mock
 * submission fails and each landed check returns the next verdict.
 */
let e2eMockWithdrawChecks: WithdrawalLandedOutcome[] | undefined;

function readE2EMockWithdrawChecks(): WithdrawalLandedOutcome[] | undefined {
  const raw = new URLSearchParams(window.location.search).get('e2eWithdrawChecks');
  if (!raw) return undefined;
  const checks = raw.split(',').filter(
    (v): v is WithdrawalLandedOutcome => v === 'found' || v === 'not_found' || v === 'unknown'
  );
  return checks.length > 0 ? checks : undefined;
}

/**
 * Check whether a withdrawal document for this identity appeared on the
 * network after `sinceMs`. Used to disambiguate submission errors: an error
 * thrown after broadcast leaves a document behind even though the SDK call
 * failed. A few short attempts cover processing lag. Lookup failures are
 * NOT treated as "not found": see classifyWithdrawalLookups. Never throws.
 */
async function checkWithdrawalLanded(identityId: string, sinceMs: number): Promise<WithdrawalLandedOutcome> {
  if (isE2EMockMode() && e2eMockWithdrawChecks) {
    await delay(30);
    return e2eMockWithdrawChecks.shift() ?? 'unknown';
  }

  const results: WithdrawalLookupResult[] = [];
  try {
    const { fetchLatestWithdrawalStatus } = await loadPlatformModule();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await delay(5_000);
      try {
        const record = await fetchLatestWithdrawalStatus(identityId, state.network, sinceMs);
        if (record !== null) return 'found';
        results.push('not_found');
      } catch (error) {
        console.warn('Withdrawal landed-check failed:', error);
        results.push('error');
      }
    }
  } catch (error) {
    console.warn('Withdrawal landed-check could not run:', error);
  }
  return classifyWithdrawalLookups(results);
}

/**
 * Route a landed-check verdict after a withdrawal submission error:
 * found → track the payout; not_found → retryable failure; unknown →
 * outcome-unknown screen (no retry, "Check Again" only).
 */
function applyWithdrawalLandedOutcome(
  outcome: WithdrawalLandedOutcome,
  identityId: string,
  sinceMs: number,
  error: string
): void {
  if (outcome === 'found') {
    updateState(setWithdrawStatusNote(
      setWithdrawSubmitted(state),
      'The submission reported an error, but the withdrawal was found on the network — tracking its payout instead.'
    ));
    if (isE2EMockMode()) {
      // Mock mode has no network to poll; finish deterministically.
      void delay(30).then(() => {
        if (state.step === 'withdraw_tracking') {
          updateState(setWithdrawStatusUpdate(state, WithdrawalStatus.COMPLETE));
        }
      });
      return;
    }
    void pollWithdrawalStatus(identityId, sinceMs);
    return;
  }
  if (outcome === 'not_found') {
    updateState(setWithdrawSubmitError(state, error));
    return;
  }
  updateState(setWithdrawOutcomeUnknown(state, error, sinceMs));
}

/**
 * "Check Again" on the outcome-unknown screen: re-run the landed check for
 * the original submission window.
 */
async function recheckWithdrawalOutcome(): Promise<void> {
  const pending = state.withdrawOutcomeUnknown;
  const identityId = state.targetIdentityId;
  if (!pending || pending.checking || !identityId) return;
  const error = state.withdrawResult?.error || 'Withdrawal failed';

  updateState(setWithdrawOutcomeChecking(state));
  const outcome = await checkWithdrawalLanded(identityId, pending.sinceMs);

  // The user may have started over while the lookups ran.
  if (state.step !== 'withdraw_complete' || state.withdrawOutcomeUnknown?.sinceMs !== pending.sinceMs) {
    return;
  }
  applyWithdrawalLandedOutcome(outcome, identityId, pending.sinceMs, error);
}

/**
 * Poll the withdrawals contract for the payout status until it completes,
 * the user leaves the tracking step, or the timeout elapses. Poll failures are
 * informational only — the credits already left the identity, so a failure to
 * *observe* the payout must never be presented as a failed withdrawal.
 */
async function pollWithdrawalStatus(identityId: string, sinceMs: number) {
  const deadline = Date.now() + WITHDRAW_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;
  let warningShown = false;

  while (state.step === 'withdraw_tracking') {
    if (Date.now() > deadline) {
      updateState(setWithdrawTrackingTimeout(
        state,
        'The withdrawal was accepted and is still being processed by the network. During heavy volume (daily withdrawal limit) payouts can stay queued for a while — check your Core wallet later.'
      ));
      return;
    }

    await delay(WITHDRAW_POLL_INTERVAL_MS);
    if (state.step !== 'withdraw_tracking') return;

    try {
      const { fetchLatestWithdrawalStatus } = await loadPlatformModule();
      const record = await fetchLatestWithdrawalStatus(identityId, state.network, sinceMs);
      consecutiveFailures = 0;
      if (record !== null && record.status !== state.withdrawStatus) {
        // Also clears any transient polling warning
        updateState(setWithdrawStatusUpdate(state, record.status));
        warningShown = false;
      } else if (warningShown && state.step === 'withdraw_tracking') {
        updateState(setWithdrawStatusNote(state, undefined));
        warningShown = false;
      }
    } catch (error) {
      consecutiveFailures++;
      console.warn('Withdrawal status poll failed:', error);
      if (consecutiveFailures === WITHDRAW_POLL_FAILURE_WARNING_THRESHOLD && state.step === 'withdraw_tracking') {
        updateState(setWithdrawStatusNote(
          state,
          'Having trouble checking the payout status — the withdrawal itself was accepted and continues processing.'
        ));
        warningShown = true;
      }
    }
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
        // Display-only progress hint: the polling flow authenticates the
        // deposit before signing. Skip it while the recheck prompt is up,
        // since no flow is running to move past 'building_transaction'.
        if (sufficientUtxo && state.step === 'detecting_deposit' && !state.depositTimedOut) {
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

// ============================================================================
// NEAR Intents ("Pay with other crypto", mainnet)
// ============================================================================

/** A confirmed quote may be at most this much worse than the one the user approved (basis points). */
const NEAR_MAX_PRICE_CHANGE_BPS = 200n;
/** Pause after typing before pricing the swap. */
const NEAR_QUOTE_DEBOUNCE_MS = 500;
/** How often a shown price is refreshed while the user looks at it. */
const NEAR_QUOTE_REFRESH_MS = 30_000;
let nearPollController: AbortController | undefined;
let nearQuoteTimer: ReturnType<typeof setTimeout> | undefined;
/** Bumped on every input change, so replies for older inputs are dropped. */
let nearQuoteSeq = 0;

function isOnDepositStep(): boolean {
  return state.step === 'awaiting_deposit' || state.step === 'detecting_deposit';
}

/** Whether a reply for `recipient` still belongs on screen. */
function isNearQuoteCurrent(recipient: string): boolean {
  return isOnDepositStep() && state.depositAddress === recipient && Boolean(state.nearIntents);
}

async function loadNearIntentsTokens(): Promise<void> {
  if (state.nearIntents?.busy === 'tokens') return;
  if (!state.nearIntents?.tokens) {
    updateState(setNearIntentsTokensLoading(state));
    try {
      const tokens = await fetchNearIntentsTokens();
      updateState(setNearIntentsTokens(state, tokens));
    } catch (error) {
      updateState(setNearIntentsError(state, extractErrorMessage(error)));
      return;
    }
  }
  resumeNearQuote();
}

/** Price the current inputs after `delayMs`, superseding any pending or in-flight quote. */
function scheduleNearQuote(delayMs = NEAR_QUOTE_DEBOUNCE_MS): void {
  clearTimeout(nearQuoteTimer);
  nearQuoteSeq++;
  nearQuoteTimer = setTimeout(() => void refreshNearQuote(false), delayMs);
}

/** Refresh the shown price in the background after `delayMs`, keeping it on screen meanwhile. */
function armNearQuoteRefresh(delayMs = NEAR_QUOTE_REFRESH_MS): void {
  clearTimeout(nearQuoteTimer);
  nearQuoteTimer = setTimeout(() => void refreshNearQuote(true), delayMs);
}

/**
 * Pricing pauses while the picker or the DASH tab is shown; pick it up again
 * when the form is back: refresh a shown price, or price from scratch.
 */
function resumeNearQuote(): void {
  if (state.nearIntents?.quote) armNearQuoteRefresh(0);
  else scheduleNearQuote(0);
}

type NearQuoteInputs = Omit<Extract<NearQuoteRequest, { dry: true }>, 'dry'>;

/**
 * Validated quote inputs from the form; null when there is nothing to price
 * yet, or what to fix (with the smallest valid amount, when that is the fix).
 */
function readNearQuoteInputs(): NearQuoteInputs | null | { error: string; minimumInput?: string } {
  const near = state.nearIntents;
  const originAsset = near?.tokens?.find((t) => t.assetId === near.originAssetId);
  if (!near || !originAsset || !state.depositAddress) return null;
  const typed = near.amountInput.trim();
  if (!typed) return null;
  const minAmountOutDuffs = depositMinimumDuffs(state);
  const base = { originAsset, minAmountOutDuffs, recipient: state.depositAddress };
  if (near.amountSide === 'out') {
    const duffs = parseUnits(typed, 8);
    if (duffs === null) return { error: 'Enter a valid DASH amount (up to 8 decimal places).' };
    if (BigInt(duffs) < BigInt(minAmountOutDuffs)) {
      const minimum = formatUnits(String(minAmountOutDuffs), 8);
      return { error: `This deposit needs at least ${minimum} DASH.`, minimumInput: minimum };
    }
    return { ...base, swapType: 'EXACT_OUTPUT', amount: duffs };
  }
  const units = parseUnits(typed, originAsset.decimals);
  if (units === null) return { error: `Enter a valid ${originAsset.symbol} amount (up to ${originAsset.decimals} decimal places).` };
  if (BigInt(units) === 0n) return null;
  return { ...base, swapType: 'EXACT_INPUT', amount: units };
}

/**
 * For a "too small" error: an amount just above NEAR Intents' minimum,
 * formatted for the typed side. The minimum moves with the price, so it is
 * padded by 3% and rounded up to three significant digits.
 */
function nearMinimumInput(error: unknown, inputs: NearQuoteInputs): string | undefined {
  if (!(error instanceof NearIntentsError) || error.kind !== 'too_low' || error.minAmount === undefined) return undefined;
  const padded = (BigInt(error.minAmount) * 103n + 99n) / 100n;
  const step = 10n ** BigInt(Math.max(0, padded.toString().length - 3));
  const suggested = ((padded + step - 1n) / step) * step;
  if (inputs.swapType === 'EXACT_INPUT') return formatUnits(suggested.toString(), inputs.originAsset.decimals);
  const floor = BigInt(inputs.minAmountOutDuffs);
  return formatUnits((suggested > floor ? suggested : floor).toString(), 8);
}

/**
 * Price the current inputs with a dry quote. A background refresh keeps the
 * shown price on screen until the new one arrives; while a price is shown it
 * is refreshed every NEAR_QUOTE_REFRESH_MS.
 */
async function refreshNearQuote(background: boolean): Promise<void> {
  const near = state.nearIntents;
  if (!isOnDepositStep() || !near?.open || near.swap || near.pickerOpen || near.busy === 'confirm') return;
  const inputs = readNearQuoteInputs();
  if (inputs === null) {
    if (near.quote || near.error || near.busy) updateState(clearNearIntentsQuote(state));
    return;
  }
  if ('error' in inputs) {
    updateState(setNearIntentsError(clearNearIntentsQuote(state), inputs.error, inputs.minimumInput));
    return;
  }
  const seq = nearQuoteSeq;
  // Replies for older inputs are dropped; confirming bumps the counter too.
  const stale = () => seq !== nearQuoteSeq || !isNearQuoteCurrent(inputs.recipient);
  if (!background) updateState(setNearIntentsQuoting(state));
  try {
    const quote = await requestNearIntentsQuote({ ...inputs, dry: true });
    if (stale()) return;
    updateState(setNearIntentsQuote(state, quote));
    armNearQuoteRefresh();
  } catch (error) {
    if (stale()) return;
    console.warn('NEAR Intents quote failed:', error);
    // A hiccup while refreshing keeps the shown price (confirming re-prices anyway) and retries.
    if (background && error instanceof NearIntentsError && error.kind === 'unavailable' && state.nearIntents?.quote) {
      armNearQuoteRefresh();
      return;
    }
    updateState(setNearIntentsError(clearNearIntentsQuote(state), extractErrorMessage(error), nearMinimumInput(error, inputs)));
  }
}

/**
 * Open the swap the user approved: a real quote with their refund address,
 * which hands out the payment address. A real quote noticeably worse than the
 * approved one is shown for another confirmation instead.
 */
async function confirmNearSwap(): Promise<void> {
  const near = state.nearIntents;
  const approved = near?.quote;
  if (!near || near.busy || !approved) return;
  const inputs = readNearQuoteInputs();
  if (inputs === null || 'error' in inputs) return;
  const refundError = validateRefundAddress(near.refundAddress);
  if (refundError) {
    updateState(setNearIntentsRefundError(state, refundError));
    armNearQuoteRefresh();
    return;
  }
  const refundTo = near.refundAddress.trim();
  clearTimeout(nearQuoteTimer);
  nearQuoteSeq++;
  updateState(setNearIntentsConfirming(state));
  try {
    const quote = await requestNearIntentsQuote({ ...inputs, dry: false, refundTo });
    if (!isNearQuoteCurrent(inputs.recipient)) return;
    // EXACT_INPUT: both the estimate and the guaranteed floor must hold up.
    const worse = inputs.swapType === 'EXACT_OUTPUT'
      ? isNearPriceIncreaseTooLarge(approved.amountIn, quote.amountIn, NEAR_MAX_PRICE_CHANGE_BPS)
      : isNearOutputDropTooLarge(approved.amountOut, quote.amountOut, NEAR_MAX_PRICE_CHANGE_BPS) ||
        isNearOutputDropTooLarge(approved.minAmountOut ?? approved.amountOut, quote.minAmountOut ?? '0', NEAR_MAX_PRICE_CHANGE_BPS);
    if (worse) {
      updateState(setNearIntentsError(
        setNearIntentsQuote(state, { ...quote, depositAddress: undefined, depositMemo: undefined }),
        'The price changed since your quote. Review the new amounts and confirm again.'
      ));
      armNearQuoteRefresh();
      return;
    }
    const { originAsset } = inputs;
    updateState(setNearIntentsSwap(state, {
      depositAddress: quote.depositAddress!,
      depositMemo: quote.depositMemo,
      recipient: inputs.recipient,
      refundTo,
      originAssetId: originAsset.assetId,
      symbol: originAsset.symbol,
      blockchain: originAsset.blockchain,
      decimals: originAsset.decimals,
      swapType: inputs.swapType,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      minAmountOut: quote.minAmountOut,
      deadline: quote.deadline,
      correlationId: quote.correlationId,
      status: 'PENDING_DEPOSIT',
    }));
    startNearSwapPolling();
  } catch (error) {
    console.warn('NEAR Intents quote failed:', error);
    if (!isNearQuoteCurrent(inputs.recipient)) return;
    // 1Click checks the refund address per chain; point at the field it is about.
    if (error instanceof NearIntentsError && error.kind === 'rejected' && /refund/i.test(error.message)) {
      updateState(setNearIntentsRefundError(state, `That doesn't look like a valid ${nearChainName(inputs.originAsset.blockchain)} address.`));
    } else {
      updateState(setNearIntentsError(state, extractErrorMessage(error), nearMinimumInput(error, inputs)));
    }
    armNearQuoteRefresh();
  }
}

function stopNearSwapPolling(): void {
  nearPollController?.abort();
  nearPollController = undefined;
}

function startNearSwapPolling(): void {
  stopNearSwapPolling();
  const swap = state.nearIntents?.swap;
  if (!swap) return;
  const controller = new AbortController();
  nearPollController = controller;
  void pollNearSwap(swap.depositAddress, swap.depositMemo, controller.signal, {
    getState: () => state,
    setState: updateState,
    getStatus: getNearSwapStatus,
    recheckDeposit,
  }).finally(() => {
    if (nearPollController === controller) nearPollController = undefined;
  });
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

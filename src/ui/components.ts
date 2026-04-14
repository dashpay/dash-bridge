import type { BridgeState, KeyType, KeyPurpose, SecurityLevel } from '../types.js';
import { getStepProgress, getStepDescription, ErrorCodes, ErrorCodeLabels } from './state.js';
import { shouldShowContestedWarning, countUsernameStatuses } from '../platform/dpns.js';
import { generateQRCodeDataUrl } from './qrcode.js';
import { privateKeyToWif } from '../utils/wif.js';
import { bytesToHex } from '../utils/hex.js';
import { getNetwork } from '../config.js';
import { getAssetLockDerivationPath } from '../crypto/hd.js';

// Available options for key configuration
const KEY_TYPES: KeyType[] = ['ECDSA_SECP256K1', 'ECDSA_HASH160'];
const KEY_PURPOSES: KeyPurpose[] = ['AUTHENTICATION', 'ENCRYPTION', 'TRANSFER', 'VOTING', 'OWNER'];
const SECURITY_LEVELS: SecurityLevel[] = ['MASTER', 'CRITICAL', 'HIGH', 'MEDIUM'];

/**
 * Get allowed security levels for a given purpose
 * TRANSFER purpose only allows CRITICAL security level
 */
function getAllowedSecurityLevels(purpose: KeyPurpose, includeMaster = true): SecurityLevel[] {
  if (purpose === 'TRANSFER') {
    return ['CRITICAL'];
  }
  return includeMaster ? SECURITY_LEVELS : SECURITY_LEVELS.filter(s => s !== 'MASTER');
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Render the main application UI
 */
export function render(state: BridgeState, container: HTMLElement): void {
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'bridge-container';

  // Subtle progress bar at top
  const progress = getStepProgress(state.step);
  if (progress > 0) {
    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progressBar.innerHTML = `<div class="progress-fill" style="width: ${progress}%"></div>`;
    wrapper.appendChild(progressBar);
  }

  // Header
  const header = document.createElement('header');
  header.innerHTML = `
    <h1>Dash Core → Platform Bridge</h1>
    <p class="network-badge ${state.network}">${state.network.toUpperCase()}</p>
  `;
  wrapper.appendChild(header);

  // Retry indicator banner
  if (state.retryStatus?.isRetrying) {
    const retryBanner = document.createElement('div');
    retryBanner.className = 'retry-banner';
    retryBanner.innerHTML = `
      <span class="retry-icon">↻</span>
      <span class="retry-text">Connection issue, retrying (${state.retryStatus.attempt}/${state.retryStatus.maxAttempts})...</span>
    `;
    wrapper.appendChild(retryBanner);
  }

  // Content based on step
  const content = document.createElement('div');
  content.className = 'content';

  switch (state.step) {
    case 'init':
      content.appendChild(renderInitStep(state));
      break;

    case 'configure_keys':
      content.appendChild(renderConfigureKeysStep(state));
      break;

    case 'enter_identity':
      content.appendChild(renderEnterIdentityStep(state));
      break;

    case 'enter_recipient_address':
      content.appendChild(renderEnterRecipientAddressStep(state));
      break;

    case 'awaiting_deposit':
    case 'detecting_deposit':
      content.appendChild(renderDepositStep(state));
      break;

    case 'building_transaction':
    case 'signing_transaction':
    case 'broadcasting':
    case 'waiting_islock':
    case 'registering_identity':
    case 'topping_up':
    case 'sending_to_address':
      content.appendChild(renderProcessingStep(state));
      break;

    case 'complete':
      content.appendChild(renderCompleteStep(state));
      break;

    case 'error':
      content.appendChild(renderErrorStep(state));
      break;

    // DPNS steps
    case 'dpns_choose_identity':
      content.appendChild(renderDpnsChooseIdentityStep(state));
      break;

    case 'dpns_enter_identity':
      content.appendChild(renderDpnsEnterIdentityStep(state));
      break;

    case 'dpns_enter_usernames':
      content.appendChild(renderDpnsEnterUsernamesStep(state));
      break;

    case 'dpns_checking':
      content.appendChild(renderDpnsCheckingStep(state));
      break;

    case 'dpns_review':
      content.appendChild(renderDpnsReviewStep(state));
      break;

    case 'dpns_registering':
      content.appendChild(renderDpnsRegisteringStep(state));
      break;

    case 'dpns_complete':
      content.appendChild(renderDpnsCompleteStep(state));
      break;

    // Identity Management steps
    case 'manage_enter_identity':
      content.appendChild(renderManageEnterIdentityStep(state));
      break;

    case 'manage_view_keys':
      content.appendChild(renderManageViewKeysStep(state));
      break;

    case 'manage_updating':
      content.appendChild(renderManageUpdatingStep(state));
      break;

    case 'manage_complete':
      content.appendChild(renderManageCompleteStep(state));
      break;

    // Contract registration steps
    case 'contract_choose_identity':
      content.appendChild(renderContractChooseIdentityStep(state));
      break;
    case 'contract_enter_identity':
      content.appendChild(renderContractEnterIdentityStep(state));
      break;
    case 'contract_enter_contract':
      content.appendChild(renderContractEnterContractStep(state));
      break;
    case 'contract_review':
      content.appendChild(renderContractReviewStep(state));
      break;
    case 'contract_registering':
      content.appendChild(renderProcessingStep(state));
      break;
    case 'contract_complete':
      content.appendChild(renderContractCompleteStep(state));
      break;
  }

  wrapper.appendChild(content);

  // Footer with GitHub link
  const footer = document.createElement('footer');
  footer.innerHTML = `
    <a href="https://github.com/PastaPastaPasta/dash-bridge" target="_blank" rel="noopener noreferrer" class="github-link">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
      </svg>
      View on GitHub
    </a>
  `;
  wrapper.appendChild(footer);

  container.appendChild(wrapper);
}

function renderInitStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'init-step mode-selection';

  // Intro text
  const intro = document.createElement('div');
  intro.className = 'intro';
  intro.innerHTML = `
    <p class="intro-security">All cryptographic operations happen in your browser.</p>
  `;
  div.appendChild(intro);

  // Network selector
  const networkSelector = document.createElement('div');
  networkSelector.className = 'network-selector';
  networkSelector.innerHTML = `
    <button class="network-btn testnet ${state.network === 'testnet' ? 'active' : ''}" data-network="testnet">Testnet</button>
    <button class="network-btn mainnet ${state.network === 'mainnet' ? 'active' : ''}" data-network="mainnet">Mainnet</button>
  `;
  div.appendChild(networkSelector);

  // Mode selection buttons
  const modeButtons = document.createElement('div');
  modeButtons.className = 'mode-buttons';
  modeButtons.innerHTML = `
    <button id="mode-create-btn" class="mode-btn primary-btn">
      <span class="mode-label">Create New Identity</span>
      <span class="mode-desc">Generate keys and register a new identity</span>
    </button>
    <button id="mode-topup-btn" class="mode-btn secondary-btn">
      <span class="mode-label">Top Up Existing Identity</span>
      <span class="mode-desc">Add credits to an identity you already own</span>
    </button>
    <button id="mode-send-to-address-btn" class="mode-btn secondary-btn">
      <span class="mode-label">Send to Platform Address</span>
      <span class="mode-desc">Send DASH to any Platform address</span>
    </button>
    <button id="mode-dpns-btn" class="mode-btn secondary-btn">
      <span class="mode-label">Register Username</span>
      <span class="mode-desc">Get a DPNS username for your identity</span>
    </button>
    <button id="mode-manage-btn" class="mode-btn secondary-btn">
      <span class="mode-label">Manage Identity Keys</span>
      <span class="mode-desc">Add or disable keys on an existing identity</span>
    </button>
    <button id="mode-contract-btn" class="mode-btn secondary-btn">
      <span class="mode-label">Register Data Contract</span>
      <span class="mode-desc">Publish a data contract on Dash Platform</span>
    </button>
  `;
  div.appendChild(modeButtons);

  return div;
}

function renderConfigureKeysStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'configure-keys-step';

  // Reassurance about defaults
  const reassurance = document.createElement('div');
  reassurance.className = 'keys-reassurance';
  reassurance.innerHTML = `
    <p class="keys-reassurance-text"><strong>Continue with recommended settings, or customize below.</strong></p>
  `;
  div.appendChild(reassurance);

  // Key configuration section
  const keysSection = document.createElement('div');
  keysSection.className = 'keys-section';

  // Keys list
  const keysList = document.createElement('div');
  keysList.className = 'keys-list';

  state.identityKeys.forEach((key) => {
    const keyRow = document.createElement('div');
    keyRow.className = 'key-row';
    keyRow.dataset.keyId = String(key.id);

    const allowedSecurityLevels = getAllowedSecurityLevels(key.purpose, true);
    keyRow.innerHTML = `
      <div class="key-name">${key.name}</div>
      <div class="key-config">
        <select class="key-type-select" data-key-id="${key.id}">
          ${KEY_TYPES.map((t) => `<option value="${t}" ${t === key.keyType ? 'selected' : ''}>${t.replace('ECDSA_', '')}</option>`).join('')}
        </select>
        <select class="key-purpose-select" data-key-id="${key.id}">
          ${KEY_PURPOSES.map((p) => `<option value="${p}" ${p === key.purpose ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
        <select class="key-security-select" data-key-id="${key.id}">
          ${allowedSecurityLevels.map((s) => `<option value="${s}" ${s === key.securityLevel ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="remove-key-btn" data-key-id="${key.id}" ${state.identityKeys.length <= 1 ? 'disabled' : ''}>×</button>
      </div>
    `;

    keysList.appendChild(keyRow);
  });

  keysSection.appendChild(keysList);

  // Add key button
  const addKeyBtn = document.createElement('button');
  addKeyBtn.id = 'add-key-btn';
  addKeyBtn.className = 'add-key-btn';
  addKeyBtn.textContent = '+ Add Key';
  keysSection.appendChild(addKeyBtn);

  div.appendChild(keysSection);

  // Navigation buttons
  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  const continueBtn = document.createElement('button');
  continueBtn.id = 'continue-btn';
  continueBtn.className = 'primary-btn';
  continueBtn.textContent = 'Continue';
  navButtons.appendChild(continueBtn);

  div.appendChild(navButtons);

  return div;
}

function renderEnterIdentityStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'enter-identity-step';

  // Identity ID input
  const inputSection = document.createElement('div');
  inputSection.className = 'identity-input-section';
  inputSection.innerHTML = `
    <label class="input-label">Identity ID</label>
    <input
      type="text"
      id="identity-id-input"
      class="identity-id-input"
      placeholder="Paste your identity ID here..."
      value="${state.targetIdentityId || ''}"
    />
    <p class="input-hint">The 44-character Base58 identifier for your existing identity</p>
  `;
  div.appendChild(inputSection);

  // Validation message placeholder
  const validationMsg = document.createElement('p');
  validationMsg.id = 'validation-msg';
  validationMsg.className = 'validation-msg hidden';
  div.appendChild(validationMsg);

  // Navigation buttons
  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  const continueBtn = document.createElement('button');
  continueBtn.id = 'continue-topup-btn';
  continueBtn.className = 'primary-btn';
  continueBtn.textContent = 'Continue';
  navButtons.appendChild(continueBtn);

  div.appendChild(navButtons);

  return div;
}

function renderEnterRecipientAddressStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'enter-identity-step enter-recipient-address-step';

  const headline = document.createElement('h2');
  headline.textContent = 'Send to Platform Address';
  div.appendChild(headline);

  // Recipient address input
  const inputSection = document.createElement('div');
  inputSection.className = 'identity-input-section recipient-address-input-section';

  const addrGroup = document.createElement('div');
  addrGroup.className = 'input-group';

  const hrp = getNetwork(state.network).platformHrp;
  const prefix = `${hrp}1...`;
  const prefixShort = `${hrp}1`;
  addrGroup.innerHTML = '<label class="input-label">Recipient Platform Address</label>';

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'recipient-address-input';
  input.className = 'identity-id-input recipient-address-input';
  input.placeholder = prefix;
  input.value = state.recipientPlatformAddress || '';
  addrGroup.appendChild(input);

  const hint = document.createElement('p');
  hint.className = 'input-hint';
  hint.textContent = `A bech32m platform address (starts with ${prefixShort})`;
  addrGroup.appendChild(hint);

  inputSection.appendChild(addrGroup);
  div.appendChild(inputSection);

  // Validation message placeholder
  const validationMsg = document.createElement('p');
  validationMsg.id = 'recipient-address-validation-msg';
  validationMsg.className = 'validation-msg hidden';
  div.appendChild(validationMsg);

  // Navigation buttons
  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  const continueBtn = document.createElement('button');
  continueBtn.id = 'continue-send-to-address-btn';
  continueBtn.className = 'primary-btn';
  continueBtn.textContent = 'Continue';
  if (!state.recipientPlatformAddress) {
    continueBtn.setAttribute('disabled', 'true');
  }
  navButtons.appendChild(continueBtn);

  div.appendChild(navButtons);

  return div;
}

function renderDepositStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  const isSendToAddress = state.mode === 'send_to_address';
  div.className = `deposit-step ${(state.mode === 'topup' || isSendToAddress) ? 'topup-deposit' : ''}`;

  const address = state.depositAddress || '';
  const isTopUp = state.mode === 'topup' || isSendToAddress;

  // Primary instruction - mode-aware headline
  const headline = document.createElement('h2');
  headline.className = 'deposit-headline';
  if (isSendToAddress && state.recipientPlatformAddress) {
    // Send to address mode: show truncated recipient address
    const truncatedAddr = state.recipientPlatformAddress.length > 20
      ? `${state.recipientPlatformAddress.slice(0, 12)}...${state.recipientPlatformAddress.slice(-6)}`
      : state.recipientPlatformAddress;
    headline.innerHTML = `Send to <code class="inline-id">${escapeHtml(truncatedAddr)}</code>`;
  } else if (isTopUp && state.targetIdentityId) {
    // Truncate identity ID for display
    const truncatedId = state.targetIdentityId.length > 12
      ? `${state.targetIdentityId.slice(0, 8)}...${state.targetIdentityId.slice(-4)}`
      : state.targetIdentityId;
    headline.innerHTML = `Top up <code class="inline-id">${truncatedId}</code>`;
  } else {
    const minDash = state.minimumDeposit
      ? (state.minimumDeposit / 100_000_000).toFixed(4)
      : '0.003';
    headline.innerHTML = state.minimumDeposit
      ? `Send exactly <strong>${minDash} DASH</strong>`
      : 'Send at least <strong>0.003 DASH</strong>';
  }
  div.appendChild(headline);

  // Amount instruction for top-up mode (separate line)
  if (isTopUp) {
    const minDash = state.minimumDeposit
      ? (state.minimumDeposit / 100_000_000).toFixed(4)
      : '0.003';
    const amountInstruction = document.createElement('p');
    amountInstruction.className = 'deposit-instruction';
    amountInstruction.innerHTML = `Send at least <strong>${minDash} DASH</strong>`;
    div.appendChild(amountInstruction);
  }

  // Secondary reassurance - single place for "we'll continue" message
  const reassurance = document.createElement('p');
  reassurance.className = 'deposit-reassurance';
  reassurance.textContent = "We'll continue automatically once detected.";
  div.appendChild(reassurance);

  // For testnet: Show faucet as hero action first
  if (state.network === 'testnet' && state.depositAddress) {
    const faucetSection = document.createElement('div');
    faucetSection.className = 'faucet-section faucet-hero';

    const faucetStatus = state.faucetRequestStatus || 'idle';

    if (faucetStatus === 'success' && state.faucetTxid) {
      // Success state
      const truncatedTxid = state.faucetTxid.length > 16
        ? `${state.faucetTxid.slice(0, 8)}...${state.faucetTxid.slice(-8)}`
        : state.faucetTxid;
      faucetSection.innerHTML = `
        <div class="faucet-success">
          <span class="faucet-checkmark">&#10003;</span>
          <span>1 tDASH sent!</span>
          <code class="faucet-txid" title="${state.faucetTxid}">${truncatedTxid}</code>
        </div>
      `;
    } else if (faucetStatus === 'solving_pow') {
      faucetSection.innerHTML = `
        <div class="faucet-loading">
          <div class="faucet-spinner"></div>
          <span>Solving proof of work...</span>
        </div>
      `;
    } else if (faucetStatus === 'requesting') {
      faucetSection.innerHTML = `
        <div class="faucet-loading">
          <div class="faucet-spinner"></div>
          <span>Sending funds...</span>
        </div>
      `;
    } else {
      // Idle or error state - show button with helper text
      let errorHtml = '';
      if (faucetStatus === 'error' && state.faucetError) {
        errorHtml = `<p class="faucet-error">${escapeHtml(state.faucetError)}</p>`;
      }
      faucetSection.innerHTML = `
        <p class="faucet-helper">Don't have testnet DASH?</p>
        <button id="request-faucet-btn" class="faucet-btn faucet-btn-hero">Request Testnet Funds</button>
        ${errorHtml}
      `;
    }

    div.appendChild(faucetSection);
  }

  // Collapsible section for QR/address (testnet) or regular section (mainnet)
  const depositMethodSection = document.createElement('div');
  depositMethodSection.className = state.network === 'testnet' ? 'deposit-method-section collapsible' : 'deposit-method-section';

  if (state.network === 'testnet') {
    const toggleHeader = document.createElement('button');
    toggleHeader.className = 'deposit-method-toggle';
    toggleHeader.innerHTML = `
      <span>Already have testnet DASH?</span>
      <span class="toggle-icon">&#9662;</span>
    `;
    toggleHeader.setAttribute('aria-expanded', 'false');
    depositMethodSection.appendChild(toggleHeader);
  }

  const depositMethodContent = document.createElement('div');
  depositMethodContent.className = state.network === 'testnet' ? 'deposit-method-content collapsed' : 'deposit-method-content';

  // QR section
  const qrSection = document.createElement('div');
  qrSection.className = 'qr-section';

  const qrLabel = document.createElement('p');
  qrLabel.className = 'qr-label';
  qrLabel.textContent = 'Scan to send';
  qrSection.appendChild(qrLabel);

  const qrContainer = document.createElement('div');
  qrContainer.className = 'qr-container';
  qrContainer.innerHTML = '<div class="qr-loading">Loading...</div>';
  qrSection.appendChild(qrContainer);

  // Generate QR code asynchronously
  generateQRCodeDataUrl(address, 200).then((dataUrl) => {
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Deposit Address QR Code';
    img.width = 200;
    img.height = 200;
    qrContainer.innerHTML = '';
    qrContainer.appendChild(img);
  }).catch((err) => {
    console.error('QR code generation failed:', err);
    qrContainer.innerHTML = '<div class="qr-error">QR failed</div>';
  });

  depositMethodContent.appendChild(qrSection);

  // Mnemonic display section
  if (state.mnemonic) {
    const mnemonicSection = document.createElement('div');
    mnemonicSection.className = 'mnemonic-section';

    const mnemonicHeader = document.createElement('div');
    mnemonicHeader.className = 'mnemonic-header';
    mnemonicHeader.innerHTML = '<strong>Recovery Phrase</strong>';
    mnemonicSection.appendChild(mnemonicHeader);

    const mnemonicWarning = document.createElement('p');
    mnemonicWarning.className = 'mnemonic-warning';
    mnemonicWarning.textContent = 'Write down these 12 words in order. This is the only way to recover your keys.';
    mnemonicSection.appendChild(mnemonicWarning);

    const words = state.mnemonic.split(' ');
    const mnemonicWords = document.createElement('div');
    mnemonicWords.className = 'mnemonic-words';
    mnemonicWords.innerHTML = words.map((word, i) =>
      `<span class="mnemonic-word"><span class="word-num">${i + 1}.</span> ${word}</span>`
    ).join('');
    mnemonicSection.appendChild(mnemonicWords);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn mnemonic-copy';
    copyBtn.dataset.copy = state.mnemonic;
    copyBtn.textContent = 'Copy Phrase';
    mnemonicSection.appendChild(copyBtn);

    depositMethodContent.appendChild(mnemonicSection);
  }

  // Address with copy
  const addressSection = document.createElement('div');
  addressSection.className = 'address-section';

  const addressLabel = document.createElement('p');
  addressLabel.className = 'address-label';
  addressLabel.textContent = 'Or copy the address';
  addressSection.appendChild(addressLabel);

  const addressDisplay = document.createElement('div');
  addressDisplay.className = 'address-display';
  addressDisplay.innerHTML = `
    <code class="address">${address}</code>
    <button class="copy-btn" data-copy="${address}">Copy</button>
  `;
  addressSection.appendChild(addressDisplay);

  depositMethodContent.appendChild(addressSection);
  depositMethodSection.appendChild(depositMethodContent);
  div.appendChild(depositMethodSection);

  // Recheck section only shown after timeout
  if (state.step === 'detecting_deposit' && state.depositTimedOut) {
    const recheckSection = document.createElement('div');
    recheckSection.className = 'recheck-section';

    const detectedAmount = state.detectedDepositAmount || 0;
    const detectedDash = (detectedAmount / 100_000_000).toFixed(4);

    if (detectedAmount > 0 && detectedAmount < 300000) {
      // Insufficient deposit detected
      recheckSection.className = 'recheck-section insufficient';
      recheckSection.innerHTML = `
        <p class="insufficient-title">Deposit received: ${detectedDash} DASH</p>
        <p class="insufficient-msg">Minimum required: 0.003 DASH. Send more to continue.</p>
        <button id="recheck-deposit-btn" class="secondary-btn">Check Again</button>
      `;
    } else {
      // No deposit detected
      recheckSection.innerHTML = `
        <p>No transaction detected yet.</p>
        <button id="recheck-deposit-btn" class="secondary-btn">Check Again</button>
      `;
    }

    div.appendChild(recheckSection);
  }

  // Mode-specific note at bottom
  if (state.mode === 'topup' || state.mode === 'send_to_address') {
    // One-time key warning for top-up
    const keyWarning = document.createElement('div');
    keyWarning.className = 'key-warning';
    keyWarning.innerHTML = `
      <p><strong>Important:</strong> This is a one-time address.</p>
      <p>A recovery key was downloaded automatically. Keep it safe to recover funds if something goes wrong.</p>
    `;
    div.appendChild(keyWarning);
  } else {
    // Key backup confirmation for create mode
    const backupNote = document.createElement('p');
    backupNote.className = 'backup-note';
    backupNote.innerHTML = '<span class="backup-check">✓</span> Keys saved. Keep the download safe if you close this page.';
    div.appendChild(backupNote);
  }

  return div;
}

function renderProcessingStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'processing-step';
  const isTopUp = state.mode === 'topup';
  const isSendToAddress = state.mode === 'send_to_address';

  // Headline
  const headline = document.createElement('h2');
  headline.className = 'processing-headline';
  headline.textContent = isSendToAddress
    ? 'Sending to platform address'
    : isTopUp ? 'Processing top-up' : 'Creating your identity';
  div.appendChild(headline);

  // Subtitle
  const subtitle = document.createElement('p');
  subtitle.className = 'processing-subtitle';
  subtitle.textContent = isSendToAddress
    ? 'Sending credits to the platform address.'
    : isTopUp
      ? 'Adding credits to your identity on Dash Platform.'
      : 'Registering your identity on Dash Platform. This may take a moment.';
  div.appendChild(subtitle);

  const spinner = document.createElement('div');
  spinner.className = 'spinner large';
  div.appendChild(spinner);

  // Status text
  const status = document.createElement('p');
  status.className = 'processing-status';
  status.textContent = 'Waiting for confirmation...';
  div.appendChild(status);

  // Transaction details card
  const detailsCard = document.createElement('div');
  detailsCard.className = 'processing-details';

  if (state.txid) {
    const txRow = document.createElement('div');
    txRow.className = 'detail-row';
    txRow.innerHTML = `
      <label>Transaction ID</label>
      <code class="txid">${state.txid}</code>
    `;
    detailsCard.appendChild(txRow);
  }

  if (state.depositAmount) {
    const amountDash = Number(state.depositAmount) / 100_000_000;
    const amountRow = document.createElement('div');
    amountRow.className = 'detail-row';
    amountRow.innerHTML = `
      <label>Amount</label>
      <span class="amount">${amountDash.toFixed(8)} DASH</span>
    `;
    detailsCard.appendChild(amountRow);
  }

  if (detailsCard.children.length > 0) {
    div.appendChild(detailsCard);
  }

  return div;
}

function renderCompleteStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  const isTopUp = state.mode === 'topup';
  const isSendToAddress = state.mode === 'send_to_address';
  div.className = `complete-step ${(isTopUp || isSendToAddress) ? 'topup-complete' : ''}`;

  // Lead with mode-specific headline
  const headline = document.createElement('h2');
  headline.className = 'complete-headline';
  headline.textContent = isSendToAddress
    ? 'Send complete!'
    : isTopUp ? 'Top-up complete!' : 'Save your keys';
  div.appendChild(headline);

  const subtitle = document.createElement('p');
  subtitle.className = 'complete-subtitle';
  subtitle.textContent = isSendToAddress
    ? 'Credits have been sent to the platform address.'
    : isTopUp
      ? 'Credits have been added to your identity.'
      : 'Your identity was created. Download your keys to access it.';
  div.appendChild(subtitle);

  if (!isTopUp && !isSendToAddress) {
    // Primary action - key backup (only for create mode)
    const backupSection = document.createElement('div');
    backupSection.className = 'backup-section';
    backupSection.innerHTML = `
      <button id="download-keys-btn" class="primary-btn">Download Key Backup</button>
      <p class="backup-warning">Keys cannot be recovered if lost.</p>
    `;
    div.appendChild(backupSection);
  }

  // Identity/address info
  if (isSendToAddress && state.recipientPlatformAddress) {
    const addressInfo = document.createElement('div');
    addressInfo.className = 'identity-info';
    addressInfo.innerHTML = `
      <label>Recipient Address</label>
      <code class="identity-id">${escapeHtml(state.recipientPlatformAddress)}</code>
    `;
    div.appendChild(addressInfo);
  } else {
    const identityInfo = document.createElement('div');
    identityInfo.className = 'identity-info';
    identityInfo.innerHTML = `
      <label>${isTopUp ? 'Identity ID' : 'Your Identity ID'}</label>
      <code class="identity-id">${state.identityId || state.targetIdentityId || 'Unknown'}</code>
    `;
    div.appendChild(identityInfo);
  }

  // Transaction ID (for top-up/send_to_address mode)
  if ((isTopUp || isSendToAddress) && state.txid) {
    const txInfo = document.createElement('div');
    txInfo.className = 'tx-info';
    txInfo.innerHTML = `
      <label>Transaction ID</label>
      <code class="txid">${state.txid}</code>
    `;
    div.appendChild(txInfo);
  }

  // Contract prompt (when user came from contract flow)
  if (!isTopUp && !isSendToAddress && state.identityId && state.contractFromIdentityCreation) {
    const contractPrompt = document.createElement('div');
    contractPrompt.className = 'dpns-prompt';
    contractPrompt.innerHTML = `
      <h3>Publish your contract</h3>
      <p>Continue to publish your data contract using this identity.</p>
      <button id="contract-from-identity-btn" class="primary-btn">Publish Contract</button>
    `;
    div.appendChild(contractPrompt);
  }

  // DPNS prompt (only for create mode, not top-up or send_to_address, not contract flow)
  if (!isTopUp && !isSendToAddress && state.identityId && !state.contractFromIdentityCreation) {
    const dpnsPrompt = document.createElement('div');
    dpnsPrompt.className = 'dpns-prompt';
    dpnsPrompt.innerHTML = `
      <h3>Get a username?</h3>
      <p>Register a DPNS username like <code>yourname.dash</code> to make your identity easy to find.</p>
      <button id="dpns-from-identity-btn" class="primary-btn">Register Username</button>
    `;
    div.appendChild(dpnsPrompt);
  }

  // Start over button (for both modes)
  const startOverBtn = document.createElement('button');
  startOverBtn.id = 'retry-btn';
  startOverBtn.className = 'secondary-btn';
  startOverBtn.textContent = 'Start Over';
  div.appendChild(startOverBtn);

  return div;
}

/** Build a full diagnostic object from the error state for dev troubleshooting */
function buildErrorDiagnostics(state: BridgeState): Record<string, unknown> {
  const errorCode = state.errorCode ?? ErrorCodes.UNKNOWN;
  const diag: Record<string, unknown> = {
    errorCode,
    errorLabel: ErrorCodeLabels[errorCode] ?? 'Unknown error',
    errorStep: state.errorStep ?? null,
    message: state.error?.message ?? 'An unknown error occurred',
    stack: state.error?.stack ?? null,
    network: state.network,
    mode: state.mode,
    timestamp: new Date().toISOString(),
  };

  // Transaction context — critical for tracking on-chain state
  // NOTE: signedTxHex is intentionally excluded — if the error occurred before
  // broadcast, a signed tx in a bug report lets anyone steal the user's funds.
  // txid + UTXO data is sufficient for on-chain lookup.
  if (state.depositAddress) diag.depositAddress = state.depositAddress;
  if (state.txid) diag.txid = state.txid;
  if (state.depositAmount !== undefined) diag.depositAmount = String(state.depositAmount);
  if (state.detectedUtxo) {
    diag.utxo = {
      txid: state.detectedUtxo.txid,
      vout: state.detectedUtxo.vout,
      satoshis: state.detectedUtxo.satoshis,
    };
  }

  // Identity context
  if (state.identityId) diag.identityId = state.identityId;
  if (state.targetIdentityId) diag.targetIdentityId = state.targetIdentityId;
  if (state.recipientPlatformAddress) diag.recipientPlatformAddress = state.recipientPlatformAddress;

  // DPNS context
  if (state.dpnsUsernames?.length) {
    diag.dpnsUsernames = state.dpnsUsernames.map(u => ({
      label: u.label,
      status: u.status,
      isAvailable: u.isAvailable ?? null,
      isContested: u.isContested ?? null,
    }));
  }
  if (state.dpnsPublicKeyId !== undefined) diag.dpnsPublicKeyId = state.dpnsPublicKeyId;
  if (state.dpnsRegistrationProgress !== undefined) diag.dpnsRegistrationProgress = state.dpnsRegistrationProgress;
  if (state.dpnsResults?.length) {
    diag.dpnsResults = state.dpnsResults.map(r => ({
      label: r.label,
      success: r.success,
      error: r.error ?? null,
      isContested: r.isContested,
    }));
  }

  // Identity management context
  if (state.manageSigningKeyInfo) diag.manageSigningKeyInfo = state.manageSigningKeyInfo;
  // Count only — ManageNewKeyConfig objects contain private key material
  if (state.manageKeysToAdd?.length) diag.manageKeysToAddCount = state.manageKeysToAdd.length;
  if (state.manageKeyIdsToDisable?.length) diag.manageKeyIdsToDisable = state.manageKeyIdsToDisable;

  // Retry state
  if (state.retryStatus) diag.retryStatus = state.retryStatus;

  // Identity keys count (not the keys themselves)
  if (state.identityKeys.length) diag.identityKeysCount = state.identityKeys.length;

  return diag;
}

function renderErrorStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'error-step';

  const diag = buildErrorDiagnostics(state);
  const errorCode = String(diag.errorCode);
  const errorLabel = String(diag.errorLabel);
  const errorMessage = String(diag.message);
  const failedStep = state.errorStep ? getStepDescription(state.errorStep) : undefined;

  const failedStepHtml = failedStep
    ? `<p class="error-failed-step">Failed during: ${escapeHtml(failedStep)}</p>`
    : '';

  // Build a concise technical summary from the diagnostic object
  const techLines: string[] = [];
  if (diag.errorStep) techLines.push(`Step: ${diag.errorStep}`);
  if (diag.depositAddress) techLines.push(`Deposit: ${diag.depositAddress}`);
  if (diag.txid) techLines.push(`TxID: ${diag.txid}`);
  if (diag.identityId) techLines.push(`Identity: ${diag.identityId}`);
  if (diag.targetIdentityId) techLines.push(`Target Identity: ${diag.targetIdentityId}`);
  if (diag.recipientPlatformAddress) techLines.push(`Recipient: ${diag.recipientPlatformAddress}`);
  if (diag.stack) techLines.push(`\nStack Trace:\n${diag.stack}`);

  const techDetailsHtml = techLines.length > 0 ? `
    <details class="error-technical">
      <summary>Technical Details</summary>
      <pre class="error-technical-content">${escapeHtml(techLines.join('\n'))}</pre>
    </details>
  ` : '';

  div.innerHTML = `
    <div class="error-icon">❌</div>
    <h2>Error</h2>
    <div class="error-code-badge">${escapeHtml(errorCode)}</div>
    <p class="error-label">${escapeHtml(errorLabel)}</p>
    ${failedStepHtml}
    <p class="error-message">${escapeHtml(errorMessage)}</p>
    ${techDetailsHtml}
    <div class="error-actions">
      <button id="retry-btn" class="secondary-btn">Try Again</button>
      <button id="copy-error-btn" class="secondary-btn">Copy Error Details</button>
    </div>
  `;

  const copyBtn = div.querySelector('#copy-error-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const copyText = JSON.stringify(diag, null, 2);
      navigator.clipboard.writeText(copyText).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy Error Details'; }, 2000);
      }).catch(() => {
        copyBtn.textContent = 'Copy failed';
        setTimeout(() => { copyBtn.textContent = 'Copy Error Details'; }, 2000);
      });
    });
  }

  return div;
}

/**
 * Create key backup JSON
 */
export function createKeyBackup(state: BridgeState): string {
  const network = getNetwork(state.network);
  const isTopUp = state.mode === 'topup';
  const isSendToAddress = state.mode === 'send_to_address';

  const backup: Record<string, unknown> = {
    network: state.network,
    created: new Date().toISOString(),
    mode: state.mode,
    depositAddress: state.depositAddress,
    txid: state.txid,
  };

  // For send_to_address: include recipient address
  if (isSendToAddress) {
    backup.recipientPlatformAddress = state.recipientPlatformAddress;
  }

  // For create mode: include mnemonic and identity keys
  if (!isTopUp && !isSendToAddress) {
    backup.mnemonic = state.mnemonic;
    backup.identityId = state.identityId;
    backup.identityKeys = state.identityKeys.map((key) => ({
      id: key.id,
      name: key.name,
      keyType: key.keyType,
      purpose: key.purpose,
      securityLevel: key.securityLevel,
      privateKeyWif: key.privateKeyWif,
      privateKeyHex: key.privateKeyHex,
      publicKeyHex: key.publicKeyHex,
      derivationPath: key.derivationPath,
    }));
    backup.assetLockKey = state.assetLockKeyPair
      ? {
          wif: privateKeyToWif(state.assetLockKeyPair.privateKey, network),
          publicKeyHex: bytesToHex(state.assetLockKeyPair.publicKey),
          derivationPath: getAssetLockDerivationPath(state.network),
        }
      : null;
  } else {
    // For top-up mode: include target identity and one-time key
    backup.targetIdentityId = state.targetIdentityId;
    backup.assetLockKey = state.assetLockKeyPair
      ? {
          wif: privateKeyToWif(state.assetLockKeyPair.privateKey, network),
          publicKeyHex: bytesToHex(state.assetLockKeyPair.publicKey),
          note: 'One-time key for top-up. Use this WIF to recover funds if top-up fails.',
        }
      : null;
  }

  return JSON.stringify(backup, null, 2);
}

/**
 * Download key backup as a file
 */
export function downloadKeyBackup(state: BridgeState): void {
  const backup = createKeyBackup(state);
  const blob = new Blob([backup], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const isTopUp = state.mode === 'topup';
  const isSendToAddress = state.mode === 'send_to_address';

  // Generate descriptive filename based on mode and available data
  let filename: string;
  if (isSendToAddress && state.recipientPlatformAddress) {
    const addrShort = state.recipientPlatformAddress.slice(-8);
    filename = `dash-send-to-address-${addrShort}-recovery.json`;
  } else if (isTopUp && state.targetIdentityId) {
    // Top-up mode: include target identity ID for reference
    const idShort = state.targetIdentityId.slice(0, 8);
    filename = `dash-topup-${idShort}-recovery.json`;
  } else if (state.identityId) {
    filename = `dash-identity-${state.identityId}.json`;
  } else if (state.depositAddress) {
    // Use first/last chars of address for recognizability
    const addr = state.depositAddress;
    const prefix = isSendToAddress ? 'dash-send' : isTopUp ? 'dash-topup' : 'dash-keys';
    filename = `${prefix}-${addr.slice(0, 6)}-${addr.slice(-4)}-pending.json`;
  } else {
    filename = `dash-keys-${Date.now()}.json`;
  }

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// DPNS Render Functions
// ============================================================================

/**
 * Render DPNS identity source selection step
 */
function renderDpnsChooseIdentityStep(_state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'dpns-choose-identity-step';

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Register a Username';
  div.appendChild(headline);

  const subtitle = document.createElement('p');
  subtitle.className = 'dpns-subtitle';
  subtitle.textContent = 'DPNS usernames make your identity easy to find and share.';
  div.appendChild(subtitle);

  const choiceButtons = document.createElement('div');
  choiceButtons.className = 'dpns-choice-buttons';
  choiceButtons.innerHTML = `
    <button id="dpns-choose-new-btn" class="mode-btn primary-btn">
      <span class="mode-label">Create New Identity First</span>
      <span class="mode-desc">Generate a new identity, then register usernames</span>
    </button>
    <button id="dpns-choose-existing-btn" class="mode-btn secondary-btn">
      <span class="mode-label">Use Existing Identity</span>
      <span class="mode-desc">Register usernames for an identity you already have</span>
    </button>
  `;
  div.appendChild(choiceButtons);

  // Back button
  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';
  const backBtn = document.createElement('button');
  backBtn.id = 'back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);
  div.appendChild(navButtons);

  return div;
}

/**
 * Helper to get security level name
 */
function getSecurityLevelName(level: number): string {
  switch (level) {
    case 0: return 'MASTER';
    case 1: return 'CRITICAL';
    case 2: return 'HIGH';
    case 3: return 'MEDIUM';
    default: return `UNKNOWN(${level})`;
  }
}

/**
 * Render DPNS existing identity entry step
 */
function renderDpnsEnterIdentityStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'dpns-enter-identity-step';

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Enter Your Identity';
  div.appendChild(headline);

  const form = document.createElement('div');
  form.className = 'dpns-identity-form';

  const isFetching = state.dpnsIdentityFetching === true;
  const hasFetched = state.dpnsIdentityKeys !== undefined;
  const hasFetchError = state.dpnsIdentityFetchError !== undefined;
  const hasValidatedKey = state.dpnsValidatedKeyId !== undefined;
  const hasKeyError = state.dpnsKeyValidationError !== undefined;

  // Identity status message
  let identityStatusHtml = '';
  if (isFetching) {
    identityStatusHtml = '<p class="identity-status loading">Fetching identity...</p>';
  } else if (hasFetchError) {
    identityStatusHtml = `<p class="identity-status error">${escapeHtml(state.dpnsIdentityFetchError!)}</p>`;
  } else if (hasFetched) {
    const keyCount = state.dpnsIdentityKeys!.length;
    identityStatusHtml = `<p class="identity-status success">Identity found with ${keyCount} key${keyCount !== 1 ? 's' : ''}</p>`;
  }

  // Key validation status message
  let keyValidationHtml = '';
  if (hasValidatedKey) {
    const matchedKey = state.dpnsIdentityKeys?.find(k => k.id === state.dpnsValidatedKeyId);
    const levelName = matchedKey ? getSecurityLevelName(matchedKey.securityLevel) : 'UNKNOWN';
    keyValidationHtml = `<p class="key-status success">Key matches key #${state.dpnsValidatedKeyId} (${levelName} level)</p>`;
  } else if (hasKeyError) {
    keyValidationHtml = `<p class="key-status error">${escapeHtml(state.dpnsKeyValidationError!)}</p>`;
  }

  // Always show both input fields
  form.innerHTML = `
    <div class="input-group">
      <label class="input-label">Identity ID</label>
      <input
        type="text"
        id="dpns-identity-id-input"
        class="dpns-input"
        placeholder="Your 44-character identity ID..."
        value="${state.targetIdentityId || ''}"
        ${isFetching ? 'disabled' : ''}
      />
      <p class="input-hint">The Base58 identifier for your identity</p>
      ${identityStatusHtml}
    </div>

    <div class="input-group">
      <label class="input-label">Private Key (WIF)</label>
      <input
        type="password"
        id="dpns-private-key-input"
        class="dpns-input"
        placeholder="Your private key in WIF format..."
        value="${state.dpnsPrivateKeyWif || ''}"
      />
      <p class="input-hint">An AUTHENTICATION key with CRITICAL or HIGH security level</p>
      ${keyValidationHtml}
    </div>
  `;

  div.appendChild(form);

  // Validation message placeholder
  const validationMsg = document.createElement('p');
  validationMsg.id = 'dpns-validation-msg';
  validationMsg.className = 'validation-msg hidden';
  div.appendChild(validationMsg);

  // Navigation buttons
  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'dpns-back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  // Continue button only enabled when key is validated
  const continueBtn = document.createElement('button');
  continueBtn.id = 'dpns-identity-continue-btn';
  continueBtn.className = 'primary-btn';
  continueBtn.textContent = 'Continue';
  if (!hasValidatedKey) {
    continueBtn.setAttribute('disabled', 'true');
  }
  navButtons.appendChild(continueBtn);

  div.appendChild(navButtons);

  return div;
}

/**
 * Render DPNS username entry step
 */
function renderDpnsEnterUsernamesStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'dpns-enter-usernames-step';

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Choose Your Usernames';
  div.appendChild(headline);

  const subtitle = document.createElement('p');
  subtitle.className = 'dpns-subtitle';
  subtitle.textContent = 'Enter the usernames you want to register. You can add multiple.';
  div.appendChild(subtitle);

  // Username inputs list
  const usernamesList = document.createElement('div');
  usernamesList.className = 'dpns-usernames-list';

  const usernames = state.dpnsUsernames || [];
  usernames.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'dpns-username-row';
    row.dataset.index = String(index);

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'dpns-username-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = `dpns-username-input ${!entry.isValid && entry.label ? 'invalid' : ''}`;
    input.placeholder = 'username';
    input.value = entry.label;
    input.dataset.index = String(index);
    inputWrapper.appendChild(input);

    const suffix = document.createElement('span');
    suffix.className = 'dpns-username-suffix';
    suffix.textContent = '.dash';
    inputWrapper.appendChild(suffix);

    row.appendChild(inputWrapper);

    // Status/validation indicator
    const status = document.createElement('div');
    status.className = 'dpns-username-status';
    if (entry.label && !entry.isValid) {
      status.className += ' error';
      status.textContent = entry.validationError || 'Invalid';
    } else if (entry.isContested !== undefined) {
      status.className += entry.isContested ? ' contested' : ' non-contested';
      status.textContent = entry.isContested ? 'Contested' : 'Non-contested';
    }
    row.appendChild(status);

    // Remove button (if more than one)
    if (usernames.length > 1) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-dpns-username-btn';
      removeBtn.dataset.index = String(index);
      removeBtn.innerHTML = '&times;';
      row.appendChild(removeBtn);
    }

    usernamesList.appendChild(row);
  });

  div.appendChild(usernamesList);

  // Add another username button
  const addBtn = document.createElement('button');
  addBtn.id = 'add-dpns-username-btn';
  addBtn.className = 'add-username-btn';
  addBtn.textContent = '+ Add Another Username';
  div.appendChild(addBtn);

  // Info box about contested names
  const infoBox = document.createElement('div');
  infoBox.className = 'dpns-info-box';
  infoBox.innerHTML = `
    <p><strong>Contested vs Non-Contested:</strong></p>
    <ul>
      <li><strong>Contested</strong> (3-19 chars, letters/hyphens only): Requires voting period</li>
      <li><strong>Non-contested</strong> (20+ chars or contains digits 2-9): Registered immediately</li>
    </ul>
  `;
  div.appendChild(infoBox);

  // Navigation buttons
  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'dpns-back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  const checkBtn = document.createElement('button');
  checkBtn.id = 'check-availability-btn';
  checkBtn.className = 'primary-btn';
  // Disable if no valid usernames
  const hasValidUsernames = usernames.some((u) => u.isValid);
  checkBtn.disabled = !hasValidUsernames;
  checkBtn.textContent = 'Check Availability';
  navButtons.appendChild(checkBtn);

  div.appendChild(navButtons);

  return div;
}

/**
 * Render DPNS checking availability step
 */
function renderDpnsCheckingStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'dpns-checking-step';

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Checking Availability';
  div.appendChild(headline);

  const spinner = document.createElement('div');
  spinner.className = 'spinner large';
  div.appendChild(spinner);

  const status = document.createElement('p');
  status.className = 'dpns-checking-status';
  const usernames = state.dpnsUsernames || [];
  const checking = usernames.filter((u) => u.status === 'checking');
  status.textContent = `Checking ${checking.length} username(s)...`;
  div.appendChild(status);

  return div;
}

/**
 * Render DPNS review step with availability results
 */
function renderDpnsReviewStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'dpns-review-step';

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Review Usernames';
  div.appendChild(headline);

  const usernames = state.dpnsUsernames || [];
  const counts = countUsernameStatuses(usernames);
  const showWarning = shouldShowContestedWarning(usernames);

  // Results table
  const resultsTable = document.createElement('div');
  resultsTable.className = 'dpns-results-table';

  usernames.forEach((entry) => {
    if (!entry.isValid) return; // Skip invalid entries

    const row = document.createElement('div');
    row.className = 'dpns-result-row';

    const name = document.createElement('div');
    name.className = 'dpns-result-name';
    name.innerHTML = `<code>${entry.label}.dash</code>`;
    row.appendChild(name);

    const status = document.createElement('div');
    status.className = 'dpns-result-status';

    if (entry.isAvailable) {
      status.className += ' available';
      if (entry.isContested) {
        status.innerHTML = '<span class="status-icon">&#9679;</span> Available (Contested)';
      } else {
        status.innerHTML = '<span class="status-icon">&#10003;</span> Available';
      }
    } else {
      status.className += ' taken';
      status.innerHTML = '<span class="status-icon">&#10007;</span> Taken';
    }

    row.appendChild(status);
    resultsTable.appendChild(row);
  });

  div.appendChild(resultsTable);

  // Summary
  const summary = document.createElement('p');
  summary.className = 'dpns-summary';
  if (counts.available === 0) {
    summary.textContent = 'No usernames are available. Go back to try different names.';
  } else {
    summary.textContent = `${counts.available} available (${counts.contested} contested, ${counts.nonContested} non-contested), ${counts.taken} taken`;
  }
  div.appendChild(summary);

  // Contested warning
  if (showWarning && !state.dpnsContestedWarningAcknowledged) {
    const warning = document.createElement('div');
    warning.className = 'dpns-contested-warning';
    warning.innerHTML = `
      <p><strong>Heads up:</strong> All your available usernames are contested.</p>
      <p>Contested usernames (3-19 characters, only letters/hyphens) require a voting period and may be awarded to someone else if they receive more votes.</p>
      <p>To guarantee at least one immediate username, add a non-contested name (20+ characters or contains digits 2-9).</p>
      <button id="add-noncontested-btn" class="secondary-btn">Add Non-Contested Username</button>
      <div class="dpns-contested-acknowledge">
        <label>
          <input type="checkbox" id="dpns-contested-checkbox" />
          I understand that contested names require voting and may not be awarded to me
        </label>
      </div>
    `;
    div.appendChild(warning);
  }

  // Navigation buttons
  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'dpns-back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  const registerBtn = document.createElement('button');
  registerBtn.id = 'register-dpns-btn';
  registerBtn.className = 'primary-btn';
  registerBtn.textContent = `Register ${counts.available} Username${counts.available !== 1 ? 's' : ''}`;
  // Disable if no available names or warning not acknowledged
  registerBtn.disabled = counts.available === 0 || (showWarning && !state.dpnsContestedWarningAcknowledged);
  navButtons.appendChild(registerBtn);

  div.appendChild(navButtons);

  return div;
}

/**
 * Render DPNS registration in progress step
 */
function renderDpnsRegisteringStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'dpns-registering-step';

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Registering Usernames';
  div.appendChild(headline);

  const spinner = document.createElement('div');
  spinner.className = 'spinner large';
  div.appendChild(spinner);

  const usernames = state.dpnsUsernames || [];
  const available = usernames.filter((u) => u.isValid && u.isAvailable);
  const progress = state.dpnsRegistrationProgress || 0;

  const status = document.createElement('p');
  status.className = 'dpns-registering-status';
  if (progress < available.length) {
    status.textContent = `Registering username ${progress + 1} of ${available.length}...`;
  } else {
    status.textContent = 'Finalizing registration...';
  }
  div.appendChild(status);

  const currentName = document.createElement('p');
  currentName.className = 'dpns-current-name';
  if (progress < available.length) {
    currentName.innerHTML = `<code>${available[progress]?.label}.dash</code>`;
  }
  div.appendChild(currentName);

  return div;
}

/**
 * Render DPNS registration complete step
 */
function renderDpnsCompleteStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'dpns-complete-step';

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Registration Complete!';
  div.appendChild(headline);

  const results = state.dpnsResults || [];

  // Results summary
  const resultsSection = document.createElement('div');
  resultsSection.className = 'dpns-complete-results';

  results.forEach((result) => {
    const row = document.createElement('div');
    row.className = `dpns-complete-row ${result.success ? 'success' : 'failed'}`;

    const name = document.createElement('div');
    name.className = 'dpns-complete-name';
    name.innerHTML = `<code>${result.label}.dash</code>`;
    row.appendChild(name);

    const status = document.createElement('div');
    status.className = 'dpns-complete-status';
    if (result.success) {
      if (result.isContested) {
        status.innerHTML = '<span class="status-icon">&#9679;</span> Entered voting period';
        status.className += ' contested';
      } else {
        status.innerHTML = '<span class="status-icon">&#10003;</span> Registered';
        status.className += ' registered';
      }
    } else {
      status.innerHTML = `<span class="status-icon">&#10007;</span> Failed: ${result.error || 'Unknown error'}`;
      status.className += ' failed';
    }
    row.appendChild(status);

    resultsSection.appendChild(row);
  });

  div.appendChild(resultsSection);

  // Identity info
  const identityInfo = document.createElement('div');
  identityInfo.className = 'identity-info';
  identityInfo.innerHTML = `
    <label>Identity ID</label>
    <code class="identity-id">${state.identityId || state.targetIdentityId || 'Unknown'}</code>
  `;
  div.appendChild(identityInfo);

  // Action buttons
  const actionButtons = document.createElement('div');
  actionButtons.className = 'dpns-action-buttons';

  const moreBtn = document.createElement('button');
  moreBtn.id = 'dpns-register-more-btn';
  moreBtn.className = 'primary-btn';
  moreBtn.textContent = 'Register More Usernames';
  actionButtons.appendChild(moreBtn);

  const startOverBtn = document.createElement('button');
  startOverBtn.id = 'retry-btn';
  startOverBtn.className = 'secondary-btn';
  startOverBtn.textContent = 'Start Over';
  actionButtons.appendChild(startOverBtn);

  div.appendChild(actionButtons);

  return div;
}

// ============================================================================
// Identity Management Render Functions
// ============================================================================

/**
 * Helper to get key type name from numeric value
 */
function getKeyTypeName(type: number): string {
  switch (type) {
    case 0: return 'ECDSA_SECP256K1';
    case 1: return 'BLS12_381';
    case 2: return 'ECDSA_HASH160';
    case 3: return 'BIP13_SCRIPT_HASH';
    case 4: return 'EDDSA_25519_HASH160';
    default: return `UNKNOWN(${type})`;
  }
}

/**
 * Helper to get key purpose name from numeric value
 */
function getKeyPurposeName(purpose: number): string {
  switch (purpose) {
    case 0: return 'AUTHENTICATION';
    case 1: return 'ENCRYPTION';
    case 2: return 'DECRYPTION';
    case 3: return 'TRANSFER';
    case 4: return 'OWNER';
    case 5: return 'VOTING';
    default: return `UNKNOWN(${purpose})`;
  }
}

/**
 * Render manage enter identity step
 */
function renderManageEnterIdentityStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'manage-enter-identity-step';

  const headline = document.createElement('h2');
  headline.className = 'manage-headline';
  headline.textContent = 'Manage Identity Keys';
  div.appendChild(headline);

  const form = document.createElement('div');
  form.className = 'manage-identity-form';

  const isFetching = state.manageIdentityFetching === true;
  const hasFetched = state.manageIdentityKeys !== undefined;
  const hasFetchError = state.manageIdentityFetchError !== undefined;
  const hasValidatedKey = state.manageSigningKeyInfo !== undefined;
  const hasKeyError = state.manageKeyValidationError !== undefined;

  // Identity status message
  let identityStatusHtml = '';
  if (isFetching) {
    identityStatusHtml = '<p class="identity-status loading">Fetching identity...</p>';
  } else if (hasFetchError) {
    identityStatusHtml = `<p class="identity-status error">${escapeHtml(state.manageIdentityFetchError!)}</p>`;
  } else if (hasFetched) {
    const keyCount = state.manageIdentityKeys!.length;
    identityStatusHtml = `<p class="identity-status success">Identity found with ${keyCount} key${keyCount !== 1 ? 's' : ''}</p>`;
  }

  // Key validation status message
  let keyValidationHtml = '';
  if (hasValidatedKey) {
    const levelName = getSecurityLevelName(state.manageSigningKeyInfo!.securityLevel);
    keyValidationHtml = `<p class="key-status success">Key matches key #${state.manageSigningKeyInfo!.keyId} (${levelName} level)</p>`;
  } else if (hasKeyError) {
    keyValidationHtml = `<p class="key-status error">${escapeHtml(state.manageKeyValidationError!)}</p>`;
  }

  form.innerHTML = `
    <div class="input-group">
      <label class="input-label">Identity ID</label>
      <input
        type="text"
        id="manage-identity-id-input"
        class="manage-input"
        placeholder="Your 44-character identity ID..."
        value="${state.targetIdentityId || ''}"
        ${isFetching ? 'disabled' : ''}
      />
      <p class="input-hint">The Base58 identifier for your identity</p>
      ${identityStatusHtml}
    </div>

    <div class="input-group">
      <label class="input-label">Private Key (WIF)</label>
      <input
        type="password"
        id="manage-private-key-input"
        class="manage-input"
        placeholder="Your private key in WIF format..."
        value="${state.managePrivateKeyWif || ''}"
      />
      <p class="input-hint">Only MASTER level keys can modify identity keys</p>
      ${keyValidationHtml}
    </div>
  `;

  div.appendChild(form);

  // Navigation buttons
  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'manage-back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  // Continue button only enabled when key is validated
  const continueBtn = document.createElement('button');
  continueBtn.id = 'manage-identity-continue-btn';
  continueBtn.className = 'primary-btn';
  continueBtn.textContent = 'Continue';
  if (!hasValidatedKey) {
    continueBtn.setAttribute('disabled', 'true');
  }
  navButtons.appendChild(continueBtn);

  div.appendChild(navButtons);

  return div;
}

/**
 * Render manage view keys step
 */
function renderManageViewKeysStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'manage-view-keys-step';

  const headline = document.createElement('h2');
  headline.className = 'manage-headline';
  headline.textContent = 'Manage Keys';
  div.appendChild(headline);

  // Show loading state while refetching keys
  if (state.manageIdentityFetching) {
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'manage-loading';
    loadingDiv.innerHTML = `
      <div class="spinner"></div>
      <p>Refreshing identity keys...</p>
    `;
    div.appendChild(loadingDiv);
    return div;
  }

  // Show error if key fetch failed
  if (state.manageIdentityFetchError && !state.manageIdentityKeys) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'manage-error';
    errorDiv.innerHTML = `
      <p class="error-message">${state.manageIdentityFetchError}</p>
      <button id="manage-back-btn" class="secondary-btn">Go Back</button>
    `;
    div.appendChild(errorDiv);
    return div;
  }

  const signingKeyId = state.manageSigningKeyInfo?.keyId;
  const keysToDisable = state.manageKeyIdsToDisable || [];
  const keysToAdd = state.manageKeysToAdd || [];

  // Existing keys section
  const existingSection = document.createElement('div');
  existingSection.className = 'manage-existing-keys-section';

  const existingHeader = document.createElement('h3');
  existingHeader.textContent = 'Existing Keys';
  existingSection.appendChild(existingHeader);

  const existingTable = document.createElement('div');
  existingTable.className = 'manage-keys-table';

  const identityKeys = state.manageIdentityKeys || [];
  identityKeys.forEach((key) => {
    const row = document.createElement('div');
    row.className = 'manage-key-row';
    if (keysToDisable.includes(key.id)) {
      row.className += ' to-disable';
    }
    if (key.id === signingKeyId) {
      row.className += ' signing-key';
    }
    const isAlreadyDisabled = key.isDisabled === true;
    if (isAlreadyDisabled) {
      row.className += ' already-disabled';
    }

    const isSigningKey = key.id === signingKeyId;
    const isMarkedForDisable = keysToDisable.includes(key.id);

    // Determine what to show in the toggle column
    let toggleContent: string;
    if (isAlreadyDisabled) {
      toggleContent = '<span class="disabled-indicator" title="This key has been disabled">Disabled</span>';
    } else if (isSigningKey) {
      toggleContent = '<span class="signing-indicator" title="This key is being used to sign the update">Signing Key</span>';
    } else {
      toggleContent = `<label class="disable-checkbox-label">
          <input type="checkbox" class="manage-disable-key-checkbox" data-key-id="${key.id}" ${isMarkedForDisable ? 'checked' : ''} />
          Disable
        </label>`;
    }

    row.innerHTML = `
      <div class="key-id">Key #${key.id}</div>
      <div class="key-type">${getKeyTypeName(key.type)}</div>
      <div class="key-purpose">${getKeyPurposeName(key.purpose)}</div>
      <div class="key-security">${getSecurityLevelName(key.securityLevel)}</div>
      <div class="key-disable-toggle">
        ${toggleContent}
      </div>
    `;

    existingTable.appendChild(row);
  });

  existingSection.appendChild(existingTable);
  div.appendChild(existingSection);

  // Add new keys section
  const addSection = document.createElement('div');
  addSection.className = 'manage-add-keys-section';

  const addHeader = document.createElement('h3');
  addHeader.textContent = 'Add New Keys';
  addSection.appendChild(addHeader);

  const addKeysList = document.createElement('div');
  addKeysList.className = 'manage-add-keys-list';

  keysToAdd.forEach((key) => {
    const row = document.createElement('div');
    row.className = 'manage-add-key-row';
    row.dataset.tempId = key.tempId;

    const allowedSecurityLevels = getAllowedSecurityLevels(key.purpose, false);
    row.innerHTML = `
      <div class="add-key-config">
        <select class="manage-key-type-select" data-temp-id="${key.tempId}">
          ${KEY_TYPES.map((t) => `<option value="${t}" ${t === key.keyType ? 'selected' : ''}>${t.replace('ECDSA_', '')}</option>`).join('')}
        </select>
        <select class="manage-key-purpose-select" data-temp-id="${key.tempId}">
          ${KEY_PURPOSES.map((p) => `<option value="${p}" ${p === key.purpose ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
        <select class="manage-key-security-select" data-temp-id="${key.tempId}">
          ${allowedSecurityLevels.map((s) => `<option value="${s}" ${s === key.securityLevel ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="remove-manage-new-key-btn" data-temp-id="${key.tempId}">&times;</button>
      </div>
      ${key.source === 'generate' && key.generatedKey ? `
        <div class="add-key-backup">
          <p class="backup-warning">Save this private key (WIF):</p>
          <code class="key-wif">${key.generatedKey.privateKeyWif}</code>
          <button class="copy-btn small" data-copy="${key.generatedKey.privateKeyWif}">Copy</button>
        </div>
      ` : ''}
    `;

    addKeysList.appendChild(row);
  });

  addSection.appendChild(addKeysList);

  // Add key button
  const addKeyBtn = document.createElement('button');
  addKeyBtn.id = 'add-manage-key-btn';
  addKeyBtn.className = 'add-key-btn';
  addKeyBtn.textContent = '+ Add New Key';
  addSection.appendChild(addKeyBtn);

  div.appendChild(addSection);

  // Summary section
  const summary = document.createElement('div');
  summary.className = 'manage-summary';
  const addCount = keysToAdd.length;
  const disableCount = keysToDisable.length;
  if (addCount > 0 || disableCount > 0) {
    summary.innerHTML = `<p>Will add <strong>${addCount}</strong> key${addCount !== 1 ? 's' : ''}, disable <strong>${disableCount}</strong> key${disableCount !== 1 ? 's' : ''}</p>`;
  } else {
    summary.innerHTML = '<p class="no-changes">No changes configured</p>';
  }
  div.appendChild(summary);

  // Navigation buttons
  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'manage-back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  const applyBtn = document.createElement('button');
  applyBtn.id = 'apply-manage-btn';
  applyBtn.className = 'primary-btn';
  applyBtn.textContent = 'Apply Changes';
  if (addCount === 0 && disableCount === 0) {
    applyBtn.setAttribute('disabled', 'true');
  }
  navButtons.appendChild(applyBtn);

  div.appendChild(navButtons);

  return div;
}

/**
 * Render manage updating step
 */
function renderManageUpdatingStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'manage-updating-step';

  const headline = document.createElement('h2');
  headline.className = 'manage-headline';
  headline.textContent = 'Updating Identity';
  div.appendChild(headline);

  const subtitle = document.createElement('p');
  subtitle.className = 'manage-subtitle';
  subtitle.textContent = 'Submitting identity update transition to Dash Platform...';
  div.appendChild(subtitle);

  const spinner = document.createElement('div');
  spinner.className = 'spinner large';
  div.appendChild(spinner);

  const addCount = (state.manageKeysToAdd || []).length;
  const disableCount = (state.manageKeyIdsToDisable || []).length;

  const status = document.createElement('p');
  status.className = 'manage-updating-status';
  status.textContent = `Adding ${addCount} key${addCount !== 1 ? 's' : ''}, disabling ${disableCount} key${disableCount !== 1 ? 's' : ''}...`;
  div.appendChild(status);

  return div;
}

/**
 * Render manage complete step
 */
function renderManageCompleteStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'manage-complete-step';

  const result = state.manageUpdateResult;
  const isSuccess = result?.success === true;

  const headline = document.createElement('h2');
  headline.className = 'manage-headline';
  headline.textContent = isSuccess ? 'Update Complete!' : 'Update Failed';
  div.appendChild(headline);

  if (isSuccess) {
    const successMsg = document.createElement('p');
    successMsg.className = 'manage-success-msg';
    successMsg.textContent = 'Your identity keys have been updated successfully.';
    div.appendChild(successMsg);

    // Show summary of changes
    const addCount = (state.manageKeysToAdd || []).length;
    const disableCount = (state.manageKeyIdsToDisable || []).length;

    const changesSummary = document.createElement('div');
    changesSummary.className = 'manage-changes-summary';
    changesSummary.innerHTML = `
      <p>Keys added: <strong>${addCount}</strong></p>
      <p>Keys disabled: <strong>${disableCount}</strong></p>
    `;
    div.appendChild(changesSummary);
  } else {
    const errorMsg = document.createElement('div');
    errorMsg.className = 'manage-error-msg';
    errorMsg.innerHTML = `
      <p>The update could not be completed.</p>
      <p class="error-detail">${escapeHtml(result?.error || 'Unknown error')}</p>
    `;
    div.appendChild(errorMsg);
  }

  // Identity info
  const identityInfo = document.createElement('div');
  identityInfo.className = 'identity-info';
  identityInfo.innerHTML = `
    <label>Identity ID</label>
    <code class="identity-id">${state.targetIdentityId || 'Unknown'}</code>
  `;
  div.appendChild(identityInfo);

  // Action buttons
  const actionButtons = document.createElement('div');
  actionButtons.className = 'manage-action-buttons';

  if (isSuccess) {
    const moreBtn = document.createElement('button');
    moreBtn.id = 'manage-more-btn';
    moreBtn.className = 'primary-btn';
    moreBtn.textContent = 'Make More Changes';
    actionButtons.appendChild(moreBtn);
  } else {
    const retryBtn = document.createElement('button');
    retryBtn.id = 'manage-retry-btn';
    retryBtn.className = 'primary-btn';
    retryBtn.textContent = 'Try Again';
    actionButtons.appendChild(retryBtn);
  }

  const startOverBtn = document.createElement('button');
  startOverBtn.id = 'retry-btn';
  startOverBtn.className = 'secondary-btn';
  startOverBtn.textContent = 'Start Over';
  actionButtons.appendChild(startOverBtn);

  div.appendChild(actionButtons);

  return div;
}

// ============================================================================
// Contract Registration Steps
// ============================================================================

/**
 * Render the fee breakdown table used by both the enter-contract and review steps.
 */
function renderFeeTable(estimate: NonNullable<BridgeState['contractEstimate']>): string {
  const feeRows = estimate.lineItems.map(item =>
    `<tr><td>${escapeHtml(item.label)}</td><td class="num">${item.count}</td><td class="num">${(item.totalCostCredits / 100_000_000_000).toFixed(2)}</td></tr>`
  ).join('');
  const totalDash = estimate.totalDash.toFixed(2);
  return `
    <div class="fee-breakdown">
      <h4>Registration Fee</h4>
      <table class="fee-table">
        <thead><tr><th>Item</th><th class="num">Count</th><th class="num">Dash</th></tr></thead>
        <tbody>${feeRows}</tbody>
        <tfoot><tr class="total-row"><td><strong>Total</strong></td><td></td><td class="num"><strong>${totalDash} Dash</strong></td></tr></tfoot>
      </table>
    </div>`;
}

function renderContractChooseIdentityStep(_state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'dpns-choose-identity-step';

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Register a Data Contract';
  div.appendChild(headline);

  const subtitle = document.createElement('p');
  subtitle.className = 'dpns-subtitle';
  subtitle.textContent = 'Publish a data contract on Dash Platform. You\'ll need an identity to own the contract.';
  div.appendChild(subtitle);

  const choiceButtons = document.createElement('div');
  choiceButtons.className = 'dpns-choice-buttons';
  choiceButtons.innerHTML = `
    <button id="contract-choose-new-btn" class="mode-btn primary-btn">
      <span class="mode-label">Create New Identity</span>
      <span class="mode-desc">We'll create one for you with the exact funds needed</span>
    </button>
    <button id="contract-choose-existing-btn" class="mode-btn secondary-btn">
      <span class="mode-label">Use Existing Identity</span>
      <span class="mode-desc">Use an identity you already have</span>
    </button>
  `;
  div.appendChild(choiceButtons);

  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';
  const backBtn = document.createElement('button');
  backBtn.id = 'contract-back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);
  div.appendChild(navButtons);

  return div;
}

function renderContractEnterIdentityStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'dpns-enter-identity-step';

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Enter Your Identity';
  div.appendChild(headline);

  const isFetching = state.contractIdentityFetching === true;
  const hasFetched = state.contractIdentityKeys !== undefined;
  const hasFetchError = state.contractIdentityFetchError !== undefined;
  const hasValidatedKey = state.contractKeyValidated === true;
  const hasKeyError = state.contractKeyValidationError !== undefined;

  let identityStatusHtml = '';
  if (isFetching) {
    identityStatusHtml = '<p class="identity-status loading">Fetching identity...</p>';
  } else if (hasFetchError) {
    identityStatusHtml = `<p class="identity-status error">${escapeHtml(state.contractIdentityFetchError!)}</p>`;
  } else if (hasFetched) {
    const keyCount = state.contractIdentityKeys!.length;
    const balanceStr = state.contractIdentityBalance !== undefined
      ? ` &mdash; Balance: ${(state.contractIdentityBalance / 100_000_000_000).toFixed(4)} Dash`
      : '';
    identityStatusHtml = `<p class="identity-status success">Identity found with ${keyCount} key${keyCount !== 1 ? 's' : ''}${balanceStr}</p>`;
  }

  let keyValidationHtml = '';
  if (hasValidatedKey) {
    keyValidationHtml = '<p class="key-status success">Key validated</p>';
  } else if (hasKeyError) {
    keyValidationHtml = `<p class="key-status error">${escapeHtml(state.contractKeyValidationError!)}</p>`;
  }

  const form = document.createElement('div');
  form.className = 'dpns-identity-form';
  form.innerHTML = `
    <div class="input-group">
      <label class="input-label">Identity ID</label>
      <input
        type="text"
        id="contract-identity-id-input"
        class="dpns-input"
        placeholder="Your 44-character identity ID..."
        value="${state.targetIdentityId || ''}"
        ${isFetching ? 'disabled' : ''}
      />
      <p class="input-hint">The Base58 identifier for your identity</p>
      ${identityStatusHtml}
    </div>

    <div class="input-group">
      <label class="input-label">Private Key (WIF)</label>
      <input
        type="password"
        id="contract-private-key-input"
        class="dpns-input"
        placeholder="Your private key in WIF format..."
        value="${state.contractPrivateKeyWif || ''}"
      />
      <p class="input-hint">An AUTHENTICATION key with CRITICAL or HIGH security level</p>
      ${keyValidationHtml}
    </div>
  `;
  div.appendChild(form);

  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'contract-back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  const continueBtn = document.createElement('button');
  continueBtn.id = 'contract-identity-continue-btn';
  continueBtn.className = 'primary-btn';
  continueBtn.textContent = 'Continue';
  if (!hasValidatedKey) {
    continueBtn.setAttribute('disabled', 'true');
  }
  navButtons.appendChild(continueBtn);

  div.appendChild(navButtons);
  return div;
}

function renderContractEnterContractStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'contract-enter-step';

  const json = state.contractJson || '';
  const parseError = state.contractParseError;
  const parsed = state.contractParsed;
  const estimate = state.contractEstimate;
  const isNew = state.contractIdentitySource === 'new';

  let contractDisplayHtml = '';
  if (parseError) {
    contractDisplayHtml = `<div class="contract-error">${escapeHtml(parseError)}</div>`;
  } else if (parsed && estimate) {
    let docTypesHtml = '';
    if (parsed.documentTypes.length > 0) {
      docTypesHtml = parsed.documentTypes.map(dt => {
        const indexBadges = dt.indexes.map(idx => {
          const type = idx.contested ? 'contested' : idx.unique ? 'unique' : 'non-unique';
          return `<span class="index-badge badge-${type}">${escapeHtml(idx.name)} (${type})</span>`;
        }).join(' ');
        return `<div class="doc-type"><strong>${escapeHtml(dt.name)}</strong> ${indexBadges || '<span class="no-indexes">no indexes</span>'}</div>`;
      }).join('');
    }

    let tokensHtml = '';
    if (parsed.tokens.length > 0) {
      tokensHtml = `<div class="contract-section"><h4>Tokens</h4><p>${parsed.tokens.length} token${parsed.tokens.length !== 1 ? 's' : ''}</p></div>`;
    }

    let keywordsHtml = '';
    if (parsed.keywords.length > 0) {
      keywordsHtml = `<div class="contract-section"><h4>Keywords</h4><p>${parsed.keywords.map(k => escapeHtml(k)).join(', ')}</p></div>`;
    }

    const totalDash = estimate.totalDash.toFixed(2);

    let depositHtml = '';
    if (isNew) {
      const CREDITS_PER_SATOSHI = 1000; // 1 Dash = 100M satoshis = 100B credits
      const feeSatoshis = Math.ceil(estimate.totalCredits / CREDITS_PER_SATOSHI);
      const depositSatoshis = feeSatoshis + 10_000_000 + 1000;
      const depositDash = (depositSatoshis / 100_000_000).toFixed(4);
      depositHtml = `<div class="deposit-estimate"><strong>Deposit needed:</strong> ${depositDash} DASH <span class="deposit-detail">(${totalDash} fee + 0.1 buffer + tx fee)</span></div>`;
    }

    let balanceWarningHtml = '';
    if (!isNew && state.contractIdentityBalance !== undefined) {
      if (state.contractIdentityBalance < estimate.totalCredits) {
        const shortfall = ((estimate.totalCredits - state.contractIdentityBalance) / 100_000_000_000).toFixed(4);
        balanceWarningHtml = `<div class="balance-warning">Insufficient balance. Need ${shortfall} more Dash in credits.</div>`;
      }
    }

    contractDisplayHtml = `
      <div class="contract-display">
        ${docTypesHtml ? `<div class="contract-section"><h4>Document Types</h4>${docTypesHtml}</div>` : ''}
        ${tokensHtml}
        ${keywordsHtml}
        ${renderFeeTable(estimate)}
        ${depositHtml}
        ${balanceWarningHtml}
      </div>
    `;
  }

  const canContinue = parsed && estimate && !parseError;

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Enter Contract';
  div.appendChild(headline);

  const subtitle = document.createElement('p');
  subtitle.className = 'dpns-subtitle';
  subtitle.textContent = 'Paste your data contract JSON below. The registration fee will be calculated automatically.';
  div.appendChild(subtitle);

  const form = document.createElement('div');
  form.className = 'dpns-identity-form';
  form.innerHTML = `
    <div class="input-group">
      <label class="input-label">Contract JSON</label>
      <textarea id="contract-json-input" class="dpns-input contract-textarea"
                spellcheck="false" placeholder='{ "documentSchemas": { ... } }'>${escapeHtml(json)}</textarea>
    </div>
    ${contractDisplayHtml}
  `;
  div.appendChild(form);

  // Deep link copy button (only when contract is valid)
  if (parsed && json) {
    const deepLinkSection = document.createElement('div');
    deepLinkSection.className = 'contract-deep-link';
    const copyLinkBtn = document.createElement('button');
    copyLinkBtn.id = 'contract-copy-link-btn';
    copyLinkBtn.className = 'tertiary-btn';
    copyLinkBtn.textContent = 'Copy Deep Link';
    copyLinkBtn.title = 'Copy a shareable URL that pre-fills this contract';
    deepLinkSection.appendChild(copyLinkBtn);
    const linkStatus = document.createElement('span');
    linkStatus.id = 'contract-link-status';
    linkStatus.className = 'link-status';
    deepLinkSection.appendChild(linkStatus);
    div.appendChild(deepLinkSection);
  }

  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'contract-back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  const reviewBtn = document.createElement('button');
  reviewBtn.id = 'contract-review-btn';
  reviewBtn.className = 'primary-btn';
  reviewBtn.textContent = 'Review & Publish';
  if (!canContinue) reviewBtn.setAttribute('disabled', 'true');
  navButtons.appendChild(reviewBtn);

  div.appendChild(navButtons);
  return div;
}

function renderContractReviewStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'contract-review-step';

  const estimate = state.contractEstimate;
  const parsed = state.contractParsed;
  const isNew = state.contractIdentitySource === 'new';

  if (!estimate || !parsed) {
    div.innerHTML = '<p>No contract data available.</p>';
    return div;
  }

  const headline = document.createElement('h2');
  headline.className = 'dpns-headline';
  headline.textContent = 'Review Contract';
  div.appendChild(headline);

  const uniqueCount = parsed.documentTypes.reduce((s, dt) => s + dt.indexes.filter(i => i.unique && !i.contested).length, 0);
  const nonUniqueCount = parsed.documentTypes.reduce((s, dt) => s + dt.indexes.filter(i => !i.unique && !i.contested).length, 0);
  const contestedCount = parsed.documentTypes.reduce((s, dt) => s + dt.indexes.filter(i => i.contested).length, 0);

  const summaryDiv = document.createElement('div');
  summaryDiv.innerHTML = `
    <div class="review-summary">
      <ul>
        <li>${parsed.documentTypes.length} document type${parsed.documentTypes.length !== 1 ? 's' : ''}</li>
        <li>${uniqueCount + nonUniqueCount + contestedCount} indexes (${[uniqueCount && `${uniqueCount} unique`, nonUniqueCount && `${nonUniqueCount} non-unique`, contestedCount && `${contestedCount} contested`].filter(Boolean).join(', ') || 'none'})</li>
        <li>${parsed.tokens.length} token${parsed.tokens.length !== 1 ? 's' : ''}</li>
        <li>${parsed.keywords.length} keyword${parsed.keywords.length !== 1 ? 's' : ''}</li>
      </ul>
    </div>
    ${renderFeeTable(estimate)}
  `;
  div.appendChild(summaryDiv);

  // Deposit / identity info callout
  if (isNew && !state.contractFromIdentityCreation) {
    const depositDash = state.minimumDeposit ? (state.minimumDeposit / 100_000_000).toFixed(4) : '?';
    const depositInfo = document.createElement('div');
    depositInfo.className = 'deposit-estimate';
    depositInfo.innerHTML = `A new identity will be created with a deposit of <strong>${depositDash} DASH</strong>. After identity creation, the contract will be published automatically.`;
    div.appendChild(depositInfo);
  } else {
    const idLabel = state.identityId || state.targetIdentityId || '';
    if (idLabel) {
      const identityInfo = document.createElement('p');
      identityInfo.className = 'review-note';
      identityInfo.innerHTML = `Publishing with identity <code>${escapeHtml(idLabel)}</code>`;
      div.appendChild(identityInfo);
    }
  }

  // Action buttons
  const navButtons = document.createElement('div');
  navButtons.className = 'nav-buttons';

  const backBtn = document.createElement('button');
  backBtn.id = 'contract-back-btn';
  backBtn.className = 'secondary-btn';
  backBtn.textContent = 'Back';
  navButtons.appendChild(backBtn);

  if (isNew && !state.contractFromIdentityCreation) {
    const startBridgeBtn = document.createElement('button');
    startBridgeBtn.id = 'contract-start-bridge-btn';
    startBridgeBtn.className = 'primary-btn';
    startBridgeBtn.textContent = 'Continue to Deposit';
    navButtons.appendChild(startBridgeBtn);
  } else {
    const publishBtn = document.createElement('button');
    publishBtn.id = 'contract-publish-btn';
    publishBtn.className = 'primary-btn';
    publishBtn.textContent = 'Publish Contract';
    navButtons.appendChild(publishBtn);
  }

  div.appendChild(navButtons);
  return div;
}

function renderContractCompleteStep(state: BridgeState): HTMLElement {
  const div = document.createElement('div');
  div.className = 'complete-step';

  const contractId = state.contractRegisteredId || 'Unknown';
  const identityId = state.identityId || state.targetIdentityId || '';
  const estimate = state.contractEstimate;
  const parsed = state.contractParsed;
  const isTestnet = state.network === 'testnet';
  const explorerBase = isTestnet
    ? 'https://platform-explorer.com/dataContract'
    : 'https://platform-explorer.com/dataContract';

  // Success header
  const header = document.createElement('div');
  header.className = 'contract-complete-header';
  header.innerHTML = `
    <div class="success-icon">&#10003;</div>
    <h2 class="complete-headline">Contract Published!</h2>
    <p class="complete-subtitle">Your data contract is now live on Dash Platform.</p>
  `;
  div.appendChild(header);

  // Contract ID with copy
  const contractInfo = document.createElement('div');
  contractInfo.className = 'contract-id-section';
  contractInfo.innerHTML = `
    <label>Contract ID</label>
    <div class="id-row">
      <code class="identity-id">${escapeHtml(contractId)}</code>
      <button id="copy-contract-id-btn" class="tertiary-btn copy-btn" title="Copy Contract ID">Copy</button>
    </div>
    <a href="${explorerBase}/${escapeHtml(contractId)}" target="_blank" rel="noopener" class="explorer-link">View on Platform Explorer &rarr;</a>
  `;
  div.appendChild(contractInfo);

  // Owner identity with copy
  if (identityId) {
    const ownerInfo = document.createElement('div');
    ownerInfo.className = 'contract-id-section';
    ownerInfo.innerHTML = `
      <label>Owner Identity</label>
      <div class="id-row">
        <code class="identity-id">${escapeHtml(identityId)}</code>
        <button id="copy-identity-id-btn" class="tertiary-btn copy-btn" title="Copy Identity ID">Copy</button>
      </div>
    `;
    div.appendChild(ownerInfo);
  }

  // Fee summary (what was paid)
  if (estimate && parsed) {
    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'contract-complete-summary';
    summaryDiv.innerHTML = `
      <div class="complete-stats">
        <div class="stat"><span class="stat-value">${parsed.documentTypes.length}</span><span class="stat-label">doc types</span></div>
        <div class="stat"><span class="stat-value">${parsed.documentTypes.reduce((s, dt) => s + dt.indexes.length, 0)}</span><span class="stat-label">indexes</span></div>
        <div class="stat"><span class="stat-value">${parsed.tokens.length}</span><span class="stat-label">tokens</span></div>
        <div class="stat"><span class="stat-value">${estimate.totalDash.toFixed(2)}</span><span class="stat-label">Dash fee</span></div>
      </div>
    `;
    div.appendChild(summaryDiv);
  }

  // Key backup (for new identity route)
  if (state.contractFromIdentityCreation) {
    const backupSection = document.createElement('div');
    backupSection.className = 'backup-section';
    backupSection.innerHTML = `
      <button id="download-keys-btn" class="primary-btn">Download Key Backup</button>
      <p class="backup-warning">Keys cannot be recovered if lost.</p>
    `;
    div.appendChild(backupSection);
  }

  // Start over
  const startOverBtn = document.createElement('button');
  startOverBtn.id = 'retry-btn';
  startOverBtn.className = 'secondary-btn';
  startOverBtn.textContent = 'Start Over';
  div.appendChild(startOverBtn);

  // Wire up copy buttons
  setTimeout(() => {
    const copyContractBtn = div.querySelector('#copy-contract-id-btn');
    if (copyContractBtn) {
      copyContractBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(contractId).then(() => {
          copyContractBtn.textContent = 'Copied!';
          setTimeout(() => { copyContractBtn.textContent = 'Copy'; }, 2000);
        });
      });
    }
    const copyIdentityBtn = div.querySelector('#copy-identity-id-btn');
    if (copyIdentityBtn) {
      copyIdentityBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(identityId).then(() => {
          copyIdentityBtn.textContent = 'Copied!';
          setTimeout(() => { copyIdentityBtn.textContent = 'Copy'; }, 2000);
        });
      });
    }
  }, 0);

  return div;
}

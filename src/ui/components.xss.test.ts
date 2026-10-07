// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// QR rendering needs a canvas, which happy-dom does not provide.
vi.mock('./qrcode.js', () => ({
  generateQRCodeDataUrl: () => new Promise<string>(() => {}),
}));

import { render } from './components.js';
import { createInitialState } from './state.js';
import type { BridgeState } from '../types.js';

/** Breaks out of a double-quoted attribute. */
const ATTR_PAYLOAD = '"><img src=x onerror="window.__xss=1">';
/** Markup in a text context. */
const TEXT_PAYLOAD = '<img src=x onerror=window.__xss=1>';

const VALID_ID = '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA';

function renderState(overrides: Partial<BridgeState>): HTMLElement {
  const container = document.createElement('div');
  render({ ...createInitialState('testnet'), ...overrides }, container);
  return container;
}

/** No element was injected and no event-handler attribute survived. */
function expectNoInjection(container: HTMLElement): void {
  expect(container.querySelectorAll('img, script, iframe')).toHaveLength(0);
  for (const el of Array.from(container.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.startsWith('on'), `${el.tagName} has ${attr.name}`).toBe(false);
    }
  }
}

function inputValue(container: HTMLElement, id: string): string {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  expect(input).not.toBeNull();
  return input!.value;
}

describe('rendering untrusted strings', () => {
  it.each([
    ['dpns_enter_identity', 'dpns-identity-id-input', 'dpns-private-key-input', 'dpnsPrivateKeyWif'],
    ['manage_enter_identity', 'manage-identity-id-input', 'manage-private-key-input', 'managePrivateKeyWif'],
    ['contract_enter_identity', 'contract-identity-id-input', 'contract-private-key-input', 'contractPrivateKeyWif'],
  ] as const)('%s keeps identity ID and WIF inert in input values', (step, idInput, wifInput, wifField) => {
    const container = renderState({
      step,
      targetIdentityId: ATTR_PAYLOAD,
      [wifField]: ATTR_PAYLOAD,
    });
    expectNoInjection(container);
    expect(inputValue(container, idInput)).toBe(ATTR_PAYLOAD);
    expect(inputValue(container, wifInput)).toBe(ATTR_PAYLOAD);
  });

  it('keeps the top-up identity input inert', () => {
    const container = renderState({ step: 'enter_identity', mode: 'topup', targetIdentityId: ATTR_PAYLOAD });
    expectNoInjection(container);
    expect(inputValue(container, 'identity-id-input')).toBe(ATTR_PAYLOAD);
  });

  it('keeps the top-up deposit headline and faucet txid inert', () => {
    const container = renderState({
      step: 'awaiting_deposit',
      mode: 'topup',
      targetIdentityId: TEXT_PAYLOAD,
      depositAddress: 'yWdXnYxGbouNoo8yMvcbZmZ3Gdp6BpySxL',
      faucetRequestStatus: 'success',
      faucetTxid: ATTR_PAYLOAD,
    });
    expectNoInjection(container);
    expect(container.querySelector('.faucet-txid')!.getAttribute('title')).toBe(ATTR_PAYLOAD);
  });

  it('renders a DPNS registration failure error as text', () => {
    const container = renderState({
      step: 'dpns_complete',
      targetIdentityId: VALID_ID,
      dpnsResults: [{ label: TEXT_PAYLOAD, success: false, error: TEXT_PAYLOAD, isContested: false }],
    });
    expectNoInjection(container);
    expect(container.querySelector('.dpns-complete-name')!.textContent).toBe(`${TEXT_PAYLOAD}.dash`);
    expect(container.querySelector('.dpns-complete-status')!.textContent).toContain(`Failed: ${TEXT_PAYLOAD}`);
  });

  it('renders a manage identity fetch error as text', () => {
    const container = renderState({ step: 'manage_view_keys', manageIdentityFetchError: TEXT_PAYLOAD });
    expectNoInjection(container);
    expect(container.querySelector('.manage-error .error-message')!.textContent).toBe(TEXT_PAYLOAD);
  });

  it('renders DPNS labels in review and registering steps as text', () => {
    const entry = {
      label: TEXT_PAYLOAD,
      normalizedLabel: 'x',
      isValid: true,
      isAvailable: true,
      isContested: false,
      status: 'available' as const,
    };
    for (const step of ['dpns_review', 'dpns_registering'] as const) {
      const container = renderState({ step, dpnsUsernames: [entry], dpnsRegistrationProgress: 0 });
      expectNoInjection(container);
      expect(container.textContent).toContain(`${TEXT_PAYLOAD}.dash`);
    }
  });

  it('renders the processing txid and deposit address as text', () => {
    const container = renderState({ step: 'broadcasting', txid: TEXT_PAYLOAD });
    expectNoInjection(container);
    expect(container.querySelector('.txid')!.textContent).toBe(TEXT_PAYLOAD);

    const deposit = renderState({ step: 'awaiting_deposit', network: 'mainnet', depositAddress: ATTR_PAYLOAD });
    expectNoInjection(deposit);
    expect(deposit.querySelector('.address-display .copy-btn')!.getAttribute('data-copy')).toBe(ATTR_PAYLOAD);
  });

  it('keeps app-generated key material inert (key names, new-key WIF, mnemonic)', () => {
    const configure = renderState({
      step: 'configure_keys',
      identityKeys: [{ id: 0, name: TEXT_PAYLOAD, keyType: 'ECDSA_SECP256K1', purpose: 'AUTHENTICATION', securityLevel: 'MASTER' } as BridgeState['identityKeys'][number]],
    });
    expectNoInjection(configure);
    expect(configure.querySelector('.key-name')!.textContent).toBe(TEXT_PAYLOAD);

    const manage = renderState({
      step: 'manage_view_keys',
      manageIdentityKeys: [],
      manageKeysToAdd: [{
        tempId: ATTR_PAYLOAD,
        keyType: 'ECDSA_SECP256K1',
        purpose: 'AUTHENTICATION',
        securityLevel: 'HIGH',
        source: 'generate',
        generatedKey: {
          privateKey: new Uint8Array(32),
          publicKey: new Uint8Array(33),
          privateKeyHex: '',
          privateKeyWif: ATTR_PAYLOAD,
          publicKeyHex: '',
        },
      }],
    });
    expectNoInjection(manage);
    expect(manage.querySelector('.remove-manage-new-key-btn')!.getAttribute('data-temp-id')).toBe(ATTR_PAYLOAD);
    expect(manage.querySelector('.key-wif')!.textContent).toBe(ATTR_PAYLOAD);
    expect(manage.querySelector('.add-key-backup .copy-btn')!.getAttribute('data-copy')).toBe(ATTR_PAYLOAD);

    const deposit = renderState({ step: 'awaiting_deposit', network: 'mainnet', depositAddress: 'X', mnemonic: TEXT_PAYLOAD });
    expectNoInjection(deposit);
    expect(deposit.querySelector('.mnemonic-words')!.textContent).toContain('<img');
  });

  it('renders hostile NEAR Intents API strings as text', () => {
    const hostileToken = { assetId: ATTR_PAYLOAD, symbol: TEXT_PAYLOAD, blockchain: ATTR_PAYLOAD, decimals: 6 };
    const form = renderState({
      step: 'detecting_deposit',
      network: 'mainnet',
      depositAddress: 'XanAvE5GMB8CsPH78B9moJq9viEVKvCS4f',
      nearIntents: {
        open: true,
        tokens: [hostileToken],
        originAssetId: ATTR_PAYLOAD,
        assetFilter: ATTR_PAYLOAD,
        amountInput: ATTR_PAYLOAD,
        refundAddress: ATTR_PAYLOAD,
        error: TEXT_PAYLOAD,
        quote: { originAssetId: ATTR_PAYLOAD, amountIn: '1', amountOut: '5000000', deadline: ATTR_PAYLOAD },
      },
    });
    expectNoInjection(form);
    expect(form.querySelector('.near-intents-error')!.textContent).toBe(TEXT_PAYLOAD);
    expect(form.querySelector<HTMLSelectElement>('#near-asset-select')!.value).toBe(ATTR_PAYLOAD);
    expect(inputValue(form, 'near-refund-input')).toBe(ATTR_PAYLOAD);
    expect(inputValue(form, 'near-amount-input')).toBe(ATTR_PAYLOAD);
    expect(inputValue(form, 'near-asset-filter')).toBe(ATTR_PAYLOAD);
    expect(form.querySelector('#near-intents-quote')!.textContent).toContain(TEXT_PAYLOAD);

    const swap = renderState({
      step: 'detecting_deposit',
      network: 'mainnet',
      depositAddress: 'XanAvE5GMB8CsPH78B9moJq9viEVKvCS4f',
      nearIntents: {
        open: true,
        assetFilter: '',
        amountInput: '0.05',
        refundAddress: '',
        swap: {
          depositAddress: ATTR_PAYLOAD,
          depositMemo: TEXT_PAYLOAD,
          recipient: 'XanAvE5GMB8CsPH78B9moJq9viEVKvCS4f',
          refundTo: TEXT_PAYLOAD,
          originAssetId: ATTR_PAYLOAD,
          symbol: TEXT_PAYLOAD,
          blockchain: ATTR_PAYLOAD,
          decimals: 6,
          amountIn: '1',
          amountOut: '5000000',
          // A valid future deadline, so the payment details are on screen.
          deadline: new Date(Date.now() + 3_600_000).toISOString(),
          correlationId: TEXT_PAYLOAD,
          status: 'PENDING_DEPOSIT',
          statusError: TEXT_PAYLOAD,
        },
      },
    });
    expectNoInjection(swap);
    expect(swap.querySelector('#near-deposit-address')!.textContent).toBe(ATTR_PAYLOAD);
    expect(swap.querySelector('#near-deposit-memo')!.textContent).toBe(TEXT_PAYLOAD);
    expect(swap.querySelector('.near-swap-address .copy-btn')!.getAttribute('data-copy')).toBe(ATTR_PAYLOAD);
    expect(swap.querySelector('.near-swap-status-error')!.textContent).toContain(TEXT_PAYLOAD);
    expect(swap.querySelector('.near-intents-warning')!.textContent).toContain(TEXT_PAYLOAD);
  });

  it('keeps the explorer link on the explorer origin', () => {
    const container = renderState({ step: 'complete', mode: 'topup', targetIdentityId: ATTR_PAYLOAD });
    expectNoInjection(container);
    const link = container.querySelector<HTMLAnchorElement>('.explorer-link')!;
    expect(link.getAttribute('href')!.startsWith('https://testnet.platform-explorer.com/identity/')).toBe(true);
    expect(link.getAttribute('href')).not.toContain('"');
  });
});

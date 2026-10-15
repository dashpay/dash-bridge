// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// QR rendering needs a canvas, which happy-dom does not provide.
vi.mock('./qrcode.js', () => ({
  generateQRCodeDataUrl: () => new Promise<string>(() => {}),
}));

import { render } from './components.js';
import { createInitialState } from './state.js';
import type { BridgeState, NearIntentsState, NearIntentsSwap } from '../types.js';
import type { NearIntentsQuote, NearIntentsToken } from '../api/near-intents.js';

const BRIDGE_ADDRESS = 'XanAvE5GMB8CsPH78B9moJq9viEVKvCS4f';
const SWAP: NearIntentsSwap = {
  depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8',
  recipient: BRIDGE_ADDRESS,
  refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D',
  originAssetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  symbol: 'USDC',
  blockchain: 'eth',
  decimals: 6,
  swapType: 'EXACT_OUTPUT',
  amountIn: '2680000',
  amountOut: '5000000',
  deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  status: 'PENDING_DEPOSIT',
};

const USDC: NearIntentsToken = { assetId: SWAP.originAssetId, symbol: 'USDC', blockchain: 'eth', decimals: 6 };
const BTC: NearIntentsToken = { assetId: 'nep141:btc.omft.near', symbol: 'BTC', blockchain: 'btc', decimals: 8 };
const DASH: NearIntentsToken = { assetId: 'nep141:dash.omft.near', symbol: 'DASH', blockchain: 'dash', decimals: 8 };
const QUOTE: NearIntentsQuote = {
  originAssetId: USDC.assetId,
  amountIn: '2680000',
  minAmountIn: '2650000',
  amountOut: '5000000',
  amountInUsd: 2.68,
  amountOutUsd: 2.65,
  timeEstimateSec: 134,
  deadline: SWAP.deadline,
};

function renderNear(near: Partial<NearIntentsState>, overrides: Partial<BridgeState> = {}): HTMLElement {
  const container = document.createElement('div');
  render({
    ...createInitialState('mainnet'),
    step: 'detecting_deposit',
    depositAddress: BRIDGE_ADDRESS,
    nearIntents: { open: true, pickerOpen: false, assetFilter: '', amountSide: 'out', amountInput: '0.05', refundAddress: '', ...near },
    ...overrides,
  }, container);
  return container;
}

function renderSwap(swap: Partial<NearIntentsSwap>, overrides: Partial<BridgeState> = {}): HTMLElement {
  return renderNear({ swap: { ...SWAP, ...swap } }, overrides);
}

describe('NEAR Intents tab', () => {
  const form = { tokens: [DASH, USDC, BTC], originAssetId: USDC.assetId };

  it('replaces the DASH QR and address while selected', () => {
    const near = renderNear(form);
    expect(near.querySelector('#deposit-tab-near')!.getAttribute('aria-selected')).toBe('true');
    expect(near.querySelector('.address-section')).toBeNull();
    const dash = renderNear({ ...form, open: false });
    expect(dash.querySelector('#deposit-tab-dash')!.getAttribute('aria-selected')).toBe('true');
    expect(dash.querySelector('.address-section')).not.toBeNull();
    expect(dash.querySelector('#near-intents-section')).toBeNull();
  });

  it('shows the quoted pay amount, rate, fees and time for a typed DASH amount', () => {
    const c = renderNear({ ...form, quote: QUOTE });
    expect((c.querySelector('#near-amount-out') as HTMLInputElement).value).toBe('0.05');
    expect((c.querySelector('#near-amount-in') as HTMLInputElement).value).toBe('2.68');
    expect(c.querySelector('#near-asset-btn')!.textContent).toContain('USDC');
    const meta = c.querySelector('#near-intents-quote')!.textContent!;
    expect(meta).toContain('1 DASH ≈ 53.60 USDC');
    expect(meta).toContain('Fees (included)');
    expect(meta).toContain('~2 min');
    expect((c.querySelector('#near-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the quoted DASH and its floor for a typed pay amount', () => {
    const quote = { ...QUOTE, amountIn: '20000000', amountOut: '39400815', minAmountOut: '39006806' };
    const c = renderNear({ ...form, amountSide: 'in', amountInput: '20', quote });
    expect((c.querySelector('#near-amount-in') as HTMLInputElement).value).toBe('20');
    expect((c.querySelector('#near-amount-out') as HTMLInputElement).value).toBe('0.394008');
    expect(c.querySelector('.near-amount-note')!.textContent).toContain('At least 0.390068 DASH');
  });

  it('cannot confirm without a quote, and says when one is loading', () => {
    const c = renderNear({ ...form, busy: 'quote' });
    expect((c.querySelector('#near-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((c.querySelector('#near-amount-in') as HTMLInputElement).placeholder).toBe('Getting price…');
  });

  it('labels the refund field for the chosen chain and shows its error', () => {
    const c = renderNear({ ...form, originAssetId: BTC.assetId, refundError: 'Not a Bitcoin address' });
    expect(c.querySelector('label[for="near-refund-input"]')!.textContent).toBe('Refund address on Bitcoin');
    expect(c.querySelector('.near-refund-error')!.textContent).toBe('Not a Bitcoin address');
  });

  it('offers the minimum after a too-small error', () => {
    const c = renderNear({ ...form, error: 'Too small', minimumInput: '0.107' });
    expect(c.querySelector('#near-use-min-btn')!.textContent).toContain('0.107 DASH');
  });

  it('lists popular assets in the picker, never DASH, and ranks exact matches first when searching', () => {
    const wbtc = { assetId: 'nep141:eth-wbtc.omft.near', symbol: 'WBTC', blockchain: 'eth', decimals: 8 };
    const picker = renderNear({ ...form, tokens: [DASH, USDC, BTC, wbtc], pickerOpen: true });
    expect(picker.querySelector('.near-picker-popular')!.textContent).toContain('BTC');
    const ids = [...picker.querySelectorAll<HTMLElement>('.near-token-option')].map((o) => o.dataset.assetId);
    expect(ids).not.toContain(DASH.assetId);
    const search = renderNear({ ...form, tokens: [DASH, USDC, wbtc, BTC], pickerOpen: true, assetFilter: 'btc' });
    const symbols = [...search.querySelectorAll('.near-token-option-symbol')].map((o) => o.textContent);
    expect(symbols).toEqual(['BTC', 'WBTC']);
  });
});

describe('NEAR Intents swap panel', () => {
  it('shows progress while a swap is under way', () => {
    const waiting = renderSwap({}).querySelector('#near-swap-status')!;
    expect(waiting.querySelector('li.current')!.textContent).toContain('Waiting for your USDC');
    const swapping = renderSwap({ status: 'PROCESSING' }).querySelector('#near-swap-status')!;
    expect(swapping.querySelectorAll('li.done')).toHaveLength(2);
    expect(swapping.querySelector('li.current')!.textContent).toContain('Swapping to DASH');
  });

  it('gives an estimate and floor for a pay-side swap', () => {
    const c = renderSwap({ swapType: 'EXACT_INPUT', amountOut: '39400815', minAmountOut: '39006806' });
    expect(c.querySelector('.near-swap-receive')!.textContent).toContain('about 0.394008 DASH (at least 0.390068)');
  });

  it('shows the payment address, a QR and the amount while waiting for payment', () => {
    const c = renderSwap({});
    expect(c.querySelector('#near-deposit-address')!.textContent).toBe(SWAP.depositAddress);
    expect(c.querySelector('.near-swap-qr')).not.toBeNull();
    expect(c.querySelector('.near-swap-instruction')!.textContent).toContain('Send exactly 2.68 USDC on Ethereum');
  });

  it('hides the payment address once an unfunded swap has expired', () => {
    const c = renderSwap({ deadline: new Date(Date.now() - 1000).toISOString() });
    expect(c.querySelector('#near-deposit-address')).toBeNull();
    expect(c.querySelector('#near-swap-status')!.textContent).toContain('Quote expired');
    expect(c.querySelector('#near-swap-reset-btn')!.textContent).toBe('Get a new quote');
  });

  it('hides the payment address within the safety margin before the deadline', () => {
    const c = renderSwap({ deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    expect(c.querySelector('#near-deposit-address')).toBeNull();
    expect(c.querySelector('#near-swap-status')!.textContent).toContain('Quote expired');
  });

  it('tells the user to send before the cutoff, not the deadline', () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    const cutoff = new Date(deadline.getTime() - 15 * 60 * 1000);
    const fmt = (d: Date) => d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
    const warning = renderSwap({ deadline: deadline.toISOString() }).querySelector('.near-intents-warning')!.textContent!;
    expect(warning).toContain(`before ${fmt(cutoff)}`);
  });

  it('hides the payment address of a partly paid swap once the cutoff passes', () => {
    const c = renderSwap({ status: 'INCOMPLETE_DEPOSIT', deadline: new Date(Date.now() - 1000).toISOString() });
    expect(c.querySelector('#near-deposit-address')).toBeNull();
    expect(c.querySelector('.near-swap-instruction')).toBeNull();
    expect(c.querySelector('#near-swap-status')!.textContent).toContain('refunded to your refund address');
    expect(c.querySelector('#near-swap-reset-btn')!.textContent).toBe('Get a new quote');
  });

  it('omits the QR when a memo is required', () => {
    const c = renderSwap({ depositMemo: '12345' });
    expect(c.querySelector('.near-swap-qr')).toBeNull();
    expect(c.querySelector('#near-deposit-memo')!.textContent).toBe('12345');
  });

  it('asks for the difference, not the full amount, after an incomplete payment', () => {
    const c = renderSwap({ status: 'INCOMPLETE_DEPOSIT' });
    const instruction = c.querySelector('.near-swap-instruction')!.textContent!;
    expect(instruction).toContain('Top up so the total you sent reaches 2.68 USDC');
    expect(instruction).not.toContain('Send exactly');
  });

  it.each(['KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'] as const)(
    'hides the payment address once the status is %s',
    (status) => {
      expect(renderSwap({ status }).querySelector('#near-deposit-address')).toBeNull();
    }
  );

  it('does not show a swap made for another deposit address', () => {
    const c = renderSwap({ recipient: 'XotherAddressxxxxxxxxxxxxxxxxxxxxx' });
    expect(c.querySelector('#near-deposit-address')).toBeNull();
    expect(c.querySelector('#near-swap-status')).toBeNull();
  });

  it('is not rendered on testnet', () => {
    const c = renderSwap({}, { network: 'testnet', depositAddress: 'yWdXnYxGbouNoo8yMvcbZmZ3Gdp6BpySxL' });
    expect(c.querySelector('#deposit-tab-near')).toBeNull();
    expect(c.querySelector('#near-intents-section')).toBeNull();
  });
});

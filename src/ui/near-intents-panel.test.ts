// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// QR rendering needs a canvas, which happy-dom does not provide.
vi.mock('./qrcode.js', () => ({
  generateQRCodeDataUrl: () => new Promise<string>(() => {}),
}));

import { render } from './components.js';
import { createInitialState } from './state.js';
import type { BridgeState, NearIntentsSwap } from '../types.js';

const BRIDGE_ADDRESS = 'XanAvE5GMB8CsPH78B9moJq9viEVKvCS4f';
const SWAP: NearIntentsSwap = {
  depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8',
  recipient: BRIDGE_ADDRESS,
  refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D',
  originAssetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  symbol: 'USDC',
  blockchain: 'eth',
  decimals: 6,
  amountIn: '2680000',
  amountOut: '5000000',
  deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  status: 'PENDING_DEPOSIT',
};

function renderSwap(swap: Partial<NearIntentsSwap>, overrides: Partial<BridgeState> = {}): HTMLElement {
  const container = document.createElement('div');
  render({
    ...createInitialState('mainnet'),
    step: 'detecting_deposit',
    depositAddress: BRIDGE_ADDRESS,
    nearIntents: { open: true, assetFilter: '', amountInput: '0.05', refundAddress: '', swap: { ...SWAP, ...swap } },
    ...overrides,
  }, container);
  return container;
}

describe('NEAR Intents swap panel', () => {
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
    expect(c.querySelector('#near-intents-toggle')).toBeNull();
  });
});

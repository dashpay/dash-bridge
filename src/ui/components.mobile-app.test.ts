// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MobilePlatform } from './mobile-app.js';

// QR rendering needs a canvas, which happy-dom does not provide.
vi.mock('./qrcode.js', () => ({
  generateQRCodeDataUrl: () => new Promise<string>(() => {}),
}));

let platform: MobilePlatform = 'desktop';
vi.mock('./mobile-app.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-app.js')>()),
  getCurrentMobilePlatform: () => platform,
}));

import { render } from './components.js';
import { createInitialState } from './state.js';
import {
  DASHPAY_ANDROID_APK_URL,
  DASHPAY_APP_STORE_URL,
  DASHPAY_GOOGLE_PLAY_URL,
} from './mobile-app.js';
import type { BridgeState } from '../types.js';

function renderState(network: string, overrides: Partial<BridgeState> = {}): HTMLElement {
  const container = document.createElement('div');
  render({ ...createInitialState(network), ...overrides }, container);
  return container;
}

function storeHrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>('.mobile-app-step a')).map((a) => a.getAttribute('href')!);
}

describe('DashPay app recommendation screen', () => {
  beforeEach(() => {
    platform = 'desktop';
  });

  it('opens every store link in a new, isolated tab', () => {
    const container = renderState('mainnet', { step: 'mobile_app_recommended' });
    const links = container.querySelectorAll<HTMLAnchorElement>('.mobile-app-step a');
    expect(links.length).toBeGreaterThan(0);
    for (const link of Array.from(links)) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('offers both stores with QR codes on desktop', () => {
    const container = renderState('mainnet', { step: 'mobile_app_recommended' });
    expect(storeHrefs(container)).toEqual([DASHPAY_APP_STORE_URL, DASHPAY_GOOGLE_PLAY_URL, DASHPAY_ANDROID_APK_URL]);
    expect(container.querySelectorAll('.mobile-app-qr')).toHaveLength(2);
    expect(container.querySelector('#mobile-app-primary-cta')).toBeNull();
  });

  it('leads with the App Store on iOS', () => {
    platform = 'ios';
    const container = renderState('mainnet', { step: 'mobile_app_recommended' });
    expect(container.querySelector('#mobile-app-primary-cta')?.getAttribute('href')).toBe(DASHPAY_APP_STORE_URL);
    expect(storeHrefs(container)).toEqual([DASHPAY_APP_STORE_URL]);
    expect(container.querySelectorAll('.mobile-app-qr')).toHaveLength(0);
  });

  it('leads with Google Play on Android and offers the APK', () => {
    platform = 'android';
    const container = renderState('mainnet', { step: 'mobile_app_recommended' });
    expect(container.querySelector('#mobile-app-primary-cta')?.getAttribute('href')).toBe(DASHPAY_GOOGLE_PLAY_URL);
    expect(storeHrefs(container)).toEqual([DASHPAY_GOOGLE_PLAY_URL, DASHPAY_ANDROID_APK_URL]);
  });

  it('keeps Continue in browser disabled until the risk is acknowledged', () => {
    const unticked = renderState('mainnet', { step: 'mobile_app_recommended' });
    expect(unticked.querySelector<HTMLInputElement>('#mobile-app-ack-checkbox')!.checked).toBe(false);
    expect(unticked.querySelector<HTMLButtonElement>('#mobile-app-continue-browser-btn')!.disabled).toBe(true);
    expect(unticked.querySelector('#back-btn')).not.toBeNull();

    const ticked = renderState('mainnet', { step: 'mobile_app_recommended', mobileAppRiskAcknowledged: true });
    expect(ticked.querySelector<HTMLInputElement>('#mobile-app-ack-checkbox')!.checked).toBe(true);
    expect(ticked.querySelector<HTMLButtonElement>('#mobile-app-continue-browser-btn')!.disabled).toBe(false);
  });
});

describe('mainnet landing hint', () => {
  beforeEach(() => {
    platform = 'desktop';
  });

  it('recommends the app on mainnet only', () => {
    expect(renderState('mainnet').querySelector('#mobile-app-hint')).not.toBeNull();
    expect(renderState('testnet').querySelector('#mobile-app-hint')).toBeNull();
  });

  it('links to the store for the current phone', () => {
    platform = 'android';
    const hint = renderState('mainnet').querySelector('#mobile-app-hint')!;
    const hrefs = Array.from(hint.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([DASHPAY_GOOGLE_PLAY_URL]);
  });
});

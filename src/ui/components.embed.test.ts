// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// QR rendering needs a canvas, which happy-dom does not provide.
vi.mock('./qrcode.js', () => ({
  generateQRCodeDataUrl: () => new Promise<string>(() => {}),
}));

import { render, renderEmbedNotice } from './components.js';
import { createInitialState, setMode, setIdentityRegistered } from './state.js';
import type { BridgeState, EmbedDisplay } from '../types.js';

const XSS = '<img src=x onerror=window.__xss=1>';
const IDENTITY_ID = '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA';
const EMBED: EmbedDisplay = { kind: 'popup', origin: 'https://app.example', appName: 'Demo App' };

function renderState(state: BridgeState): HTMLElement {
  const container = document.createElement('div');
  render(state, container);
  return container;
}

function embedded(embed: EmbedDisplay = EMBED): BridgeState {
  return { ...setMode(createInitialState('testnet'), 'create'), embed };
}

describe('embed mode UI', () => {
  it('shows who is asking, with a Cancel button, and hides the footer and Back', () => {
    const container = renderState(embedded());
    const banner = container.querySelector('.embed-banner');
    expect(banner?.textContent).toContain('Creating an identity for Demo App');
    expect(banner?.textContent).toContain('(https://app.example)');
    expect(container.querySelector('#embed-cancel-btn')).not.toBeNull();
    expect(container.querySelector('footer')).toBeNull();
    expect(container.querySelector('#back-btn')).toBeNull();
    expect(container.querySelector('#continue-btn')).not.toBeNull();
  });

  it('falls back to the origin when no app name was given', () => {
    const container = renderState(embedded({ kind: 'iframe', origin: 'https://app.example' }));
    expect(container.querySelector('.embed-banner strong')?.textContent).toBe('https://app.example');
  });

  it('escapes the app name', () => {
    const container = renderState(setIdentityRegistered(embedded({ ...EMBED, appName: XSS }), IDENTITY_ID));
    expect(container.querySelectorAll('img, script')).toHaveLength(0);
    expect(container.querySelector('.embed-banner')?.textContent).toContain(XSS);
    expect(container.querySelector('#embed-return-btn')?.textContent).toBe(`Return to ${XSS}`);
  });

  it('offers Return to app instead of other flows once complete', () => {
    const container = renderState(setIdentityRegistered(embedded(), IDENTITY_ID));
    expect(container.querySelector('#download-keys-btn')).not.toBeNull();
    expect(container.querySelector('#embed-return-btn')?.textContent).toBe('Return to Demo App');
    expect(container.querySelector('#embed-cancel-btn')).toBeNull();
    expect(container.querySelector('#dpns-from-identity-btn')).toBeNull();
    expect(container.querySelector('#retry-btn')).toBeNull();
  });

  it('hides Cancel while the identity is being registered', () => {
    const container = renderState({ ...embedded(), step: 'registering_identity' });
    expect(container.querySelector('.embed-banner')).not.toBeNull();
    expect(container.querySelector('#embed-cancel-btn')).toBeNull();
  });

  it('isolates the app name with <bdi> so it cannot reorder the origin', () => {
    const container = renderState(embedded());
    expect(container.querySelector('.embed-banner strong bdi')?.textContent).toBe('Demo App');
  });

  it('leaves the normal UI unchanged outside embed mode', () => {
    const container = renderState(setMode(createInitialState('testnet'), 'create'));
    expect(container.querySelector('.embed-banner')).toBeNull();
    expect(container.querySelector('footer')).not.toBeNull();
    expect(container.querySelector('#back-btn')).not.toBeNull();
  });

  it('renders notices with escaped text and a new-window link', () => {
    const container = document.createElement('div');
    renderEmbedNotice(container, { title: XSS, message: XSS, openHref: 'https://bridge.example/?a="b' });
    expect(container.querySelectorAll('img, script')).toHaveLength(0);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://bridge.example/?a="b');
    expect(link.getAttribute('target')).toBe('_blank');
  });
});

describe('mainnet DashPay recommendation in embed mode', () => {
  it('hides Back, since embed mode has no landing screen', () => {
    const div = document.createElement('div');
    const base = { ...createInitialState('mainnet'), step: 'mobile_app_recommended' as const };
    render({ ...base, embed: { kind: 'popup', origin: 'https://app.example' } }, div);
    expect(div.querySelector('#back-btn')).toBeNull();
    expect(div.querySelector('#mobile-app-continue-browser-btn')).not.toBeNull();
    render(base, div);
    expect(div.querySelector('#back-btn')).not.toBeNull();
  });
});

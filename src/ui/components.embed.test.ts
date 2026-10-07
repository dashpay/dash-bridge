// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// QR rendering needs a canvas, which happy-dom does not provide.
vi.mock('./qrcode.js', () => ({
  generateQRCodeDataUrl: () => new Promise<string>(() => {}),
}));

import { render, renderEmbedNotice } from './components.js';
import {
  createInitialState,
  setMode,
  setIdentityRegistered,
  setLoginInput,
  setLoginError,
  setLoginReview,
  setLoginComplete,
  setLoginCancelled,
  toggleLoginShowWif,
  clearLoginSecret,
} from './state.js';
import type { BridgeState, EmbedDisplay } from '../types.js';

const XSS = '<img src=x onerror=window.__xss=1>';
const IDENTITY_ID = '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA';
const EMBED: EmbedDisplay = { kind: 'popup', origin: 'https://app.example', appName: 'Demo App', request: 'create-identity' };

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
    const container = renderState(embedded({ kind: 'iframe', origin: 'https://app.example', request: 'create-identity' }));
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

describe('Sign in with Dash UI', () => {
  const WIF = 'cNo3S8f7ivbM1QLXVNHv39kDUNmnPj1MDxqDNk6477wd2wu9kH6w';
  const LOGIN_EMBED: EmbedDisplay = { ...EMBED, request: 'login', statement: 'Welcome back' };
  const loginState = (embed: EmbedDisplay = LOGIN_EMBED): BridgeState => ({
    ...setMode(createInitialState('testnet'), 'login'),
    embed,
  });

  it('starts on the login form with Sign in wording, a hidden WIF field and Cancel', () => {
    const container = renderState(loginState());
    expect(container.querySelector('.embed-banner')?.textContent).toContain('Sign in to Demo App');
    expect(container.querySelector('.embed-banner')?.textContent).toContain('Your private key stays in this window');
    expect(container.querySelector<HTMLInputElement>('#login-identity-input')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('#login-wif-input')?.type).toBe('password');
    expect(container.querySelector('#login-cancel-btn')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('#login-continue-btn')?.disabled).toBe(true);
    expect(container.querySelector('#mode-create-btn')).toBeNull();
  });

  it('keeps typed values, can show the WIF, and enables Continue', () => {
    const state = toggleLoginShowWif(setLoginInput(loginState(), { identityId: IDENTITY_ID, privateKeyWif: WIF }));
    const container = renderState(state);
    expect(container.querySelector<HTMLInputElement>('#login-identity-input')?.value).toBe(IDENTITY_ID);
    expect(container.querySelector<HTMLInputElement>('#login-wif-input')?.type).toBe('text');
    expect(container.querySelector('#login-wif-toggle')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('#login-continue-btn')?.disabled).toBe(false);
  });

  it('escapes errors, app name and statement', () => {
    const errored = setLoginError(loginState({ ...LOGIN_EMBED, appName: XSS, statement: XSS }), XSS);
    expect(renderState(errored).querySelector('#login-error')?.textContent).toBe(XSS);
    const review = setLoginReview(setLoginInput(errored, { identityId: IDENTITY_ID, privateKeyWif: WIF }), {
      keyId: 1,
      securityLevel: 2,
      type: 0,
    });
    const container = renderState(review);
    expect(container.querySelectorAll('img, script')).toHaveLength(0);
    expect(container.querySelector('.login-statement')?.textContent).toBe(XSS);
  });

  it('shows the app, identity and key that will sign before Sign in', () => {
    const state = setLoginReview(setLoginInput(loginState(), { identityId: IDENTITY_ID, privateKeyWif: WIF }), {
      keyId: 2,
      securityLevel: 1,
      type: 2,
    });
    const container = renderState(state);
    expect(container.textContent).toContain('Demo App');
    expect(container.textContent).toContain('(https://app.example)');
    expect(container.querySelector('#login-review-identity')?.textContent).toBe(IDENTITY_ID);
    expect(container.querySelector('#login-review-key')?.textContent).toBe('Key #2 · AUTHENTICATION · CRITICAL · ECDSA_HASH160');
    expect(container.textContent).toContain('Welcome back');
    expect(container.querySelector('#login-sign-btn')?.textContent).toBe('Sign in');
    expect(container.querySelector('#login-back-btn')).not.toBeNull();
    expect(container.querySelector('#login-cancel-btn')).not.toBeNull();
    expect(container.innerHTML).not.toContain(WIF);
  });

  it('drops the WIF once signed or cancelled, or when leaving the mode', () => {
    const typed = setLoginInput(loginState(), { identityId: IDENTITY_ID, privateKeyWif: WIF });
    const done = setLoginComplete(typed);
    expect(done.step).toBe('login_complete');
    expect(done.loginPrivateKeyWif).toBeUndefined();
    const cancelled = setLoginCancelled(typed);
    expect(cancelled.step).toBe('login_cancelled');
    expect(cancelled.loginPrivateKeyWif).toBeUndefined();
    expect(JSON.stringify(done)).not.toContain(WIF);
    expect(clearLoginSecret(typed).loginPrivateKeyWif).toBeUndefined();
    expect(setMode(typed, 'create').loginPrivateKeyWif).toBeUndefined();
    const container = renderState(done);
    expect(container.querySelector('h2')?.textContent).toBe('Signed in');
    expect(container.querySelector('#embed-cancel-btn')).toBeNull();
    // Named by the origin's host, not the app's self-declared name.
    expect(container.querySelector('#embed-return-btn')?.textContent).toBe('Return to app.example');
  });

  it('says who receives the proof by host, not by the self-declared name', () => {
    const state = setLoginReview(
      setLoginInput(loginState({ ...LOGIN_EMBED, appName: 'Dash Core Team' }), { identityId: IDENTITY_ID, privateKeyWif: WIF }),
      { keyId: 1, securityLevel: 2, type: 0 },
    );
    expect(renderState(state).querySelector('.login-note')?.textContent).toContain('Signing proves to app.example that');
  });
});

describe('mainnet DashPay recommendation in embed mode', () => {
  it('hides Back, since embed mode has no landing screen', () => {
    const div = document.createElement('div');
    const base = { ...createInitialState('mainnet'), step: 'mobile_app_recommended' as const };
    render({ ...base, embed: { kind: 'popup', origin: 'https://app.example', request: 'create-identity' } }, div);
    expect(div.querySelector('#back-btn')).toBeNull();
    expect(div.querySelector('#mobile-app-continue-browser-btn')).not.toBeNull();
    render(base, div);
    expect(div.querySelector('#back-btn')).not.toBeNull();
  });
});

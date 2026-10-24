// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// QR rendering needs a canvas, which happy-dom does not provide.
vi.mock('./qrcode.js', () => ({
  generateQRCodeDataUrl: () => new Promise<string>(() => {}),
}));

import { render } from './components.js';
import { createInitialState, setError } from './state.js';
import type { BridgeState } from '../types.js';
import { ChunkLoadError } from '../platform/chunk-loader.js';

const importFailure = () => new ChunkLoadError('evo-sdk', 3, new TypeError('Importing a module script failed.'));

function renderError(state: BridgeState, error: Error): HTMLElement {
  const container = document.createElement('div');
  render(setError(state, error), container);
  return container;
}

const lockReceived: BridgeState = {
  ...createInitialState('testnet'),
  step: 'registering_identity',
  depositAddress: 'yAddr',
  txid: 'ab'.repeat(32),
  signedTxBytes: new Uint8Array([0]),
  assetLockKeyPair: { privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) },
  assetLockProof: { type: 'instant', transactionBytes: new Uint8Array([1]), instantLockBytes: new Uint8Array([2]), outputIndex: 0 },
};

describe('error screen recovery copy', () => {
  it('after the lock arrived: says so, offers Retry Registration and the chain lock proof, names the failed chunk', () => {
    const el = renderError(lockReceived, importFailure());
    const text = el.textContent ?? '';
    expect(text).toContain('Identity registration failed');
    expect(text).not.toContain("InstantSend didn't go through");
    expect(text).toContain('the InstantSend lock arrived');
    expect(text).toContain('could not load the "evo-sdk" component');
    expect(el.querySelector('#retry-registration-btn')?.textContent).toBe('Retry Registration');
    expect(el.querySelector('#chainlock-fallback-btn')).not.toBeNull();
    expect(el.querySelector('#reload-page-btn')).toBeNull();
    expect(el.querySelector('.error-technical-content')?.textContent).toContain('Failed to load: evo-sdk');
  });

  it('labels the retry for top-up', () => {
    const el = renderError({ ...lockReceived, mode: 'topup', step: 'topping_up' }, new Error('platform reject'));
    expect(el.querySelector('#retry-registration-btn')?.textContent).toBe('Retry Top-up');
    expect(el.textContent).toContain('the Platform step failed');
  });

  it('still says InstantSend did not go through when the lock never arrived', () => {
    const el = renderError(
      { ...lockReceived, step: 'waiting_islock', assetLockProof: undefined },
      new Error('Timed out waiting for InstantSend lock')
    );
    expect(el.textContent).toContain("InstantSend didn't go through");
    expect(el.querySelector('#retry-registration-btn')).toBeNull();
  });

  it('before the deposit address: explains the failed component and offers Reload, no funding UI', () => {
    const el = renderError({ ...createInitialState('testnet'), step: 'generating_keys' }, importFailure());
    const text = el.textContent ?? '';
    expect(text).toContain('ERR-1017');
    expect(text).toContain('The page failed to load a required component "evo-sdk"');
    expect(text).toContain('No funds have been sent');
    expect(el.querySelector('#reload-page-btn')?.textContent).toBe('Reload');
    expect(el.querySelector('#retry-registration-btn')).toBeNull();
    expect(el.querySelector('#chainlock-fallback-btn')).toBeNull();
    expect(el.querySelector('#download-keys-btn')).toBeNull();
  });
});

describe('funding gate screen', () => {
  it('shows Preparing… (not a blank page) while the Platform components load', () => {
    const container = document.createElement('div');
    render({ ...createInitialState('testnet'), step: 'generating_keys' }, container);
    expect(container.querySelector('.preparing-step')?.textContent).toContain('Preparing…');
    expect(container.querySelector('.address')).toBeNull();
  });
});

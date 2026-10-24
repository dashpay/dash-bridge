// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

// QR rendering needs a canvas, which happy-dom does not provide.
vi.mock('./qrcode.js', () => ({
  generateQRCodeDataUrl: () => new Promise<string>(() => {}),
}));

import { refreshNetworkStatusTooltip, render } from './components.js';
import { createInitialState } from './state.js';
import type { NetworkStatus } from '../types.js';

const status = (overrides: Partial<NetworkStatus> = {}): NetworkStatus => ({
  health: 'healthy',
  coreHeight: 1_578_205,
  coreChainLockedHeight: 1_578_204,
  platformBlockHeight: 641_243,
  platformBlockAgeMs: 60_000,
  reasons: [],
  checkedAtMs: 1,
  ...overrides,
});

function renderWith(networkStatus?: NetworkStatus): HTMLElement {
  const container = document.createElement('div');
  render({ ...createInitialState('testnet'), networkStatus }, container);
  return container;
}

describe('network status indicator', () => {
  it('is hidden until a status exists', () => {
    expect(renderWith().querySelector('.net-status')).toBeNull();
    expect(renderWith(status()).querySelector('.net-status')).not.toBeNull();
  });

  it('shows only the Core height when Platform was not read', () => {
    const container = renderWith(
      status({
        coreChainLockedHeight: undefined,
        platformBlockHeight: undefined,
        platformBlockAgeMs: undefined,
        platformChecked: false,
      })
    );

    const indicator = container.querySelector('.net-status')!;
    expect(indicator.getAttribute('title')).toBe(
      'Core height: 1578205\nPlatform status: not read yet'
    );
    expect(indicator.textContent).toContain('Network healthy');
    expect(container.querySelector('.net-status-banner')).toBeNull();
  });

  it('drops the "not read yet" line once Platform has been read', () => {
    const container = renderWith(status({ platformChecked: false }));
    expect(container.querySelector('.net-status')!.getAttribute('title')).toContain('not read yet');

    refreshNetworkStatusTooltip(container, status());

    expect(container.querySelector('.net-status')!.getAttribute('title')).not.toContain('not read yet');
  });

  it('refreshNetworkStatusTooltip updates the numbers in place, leaving the element and label alone', () => {
    const container = renderWith(status());
    const indicator = container.querySelector('.net-status')!;
    expect(indicator.getAttribute('title')).toContain('Core height: 1578205');

    refreshNetworkStatusTooltip(
      container,
      status({ coreHeight: 1_578_213, platformBlockHeight: 641_290, platformBlockAgeMs: 180_000 })
    );

    expect(container.querySelector('.net-status')).toBe(indicator);
    expect(indicator.getAttribute('title')).toBe(
      ['Core height: 1578213', 'Platform chain-locked: 1578204', 'Platform block: 641290', 'Platform block age: 3m'].join('\n')
    );
    expect(indicator.textContent).toContain('Network healthy');
  });

  it('refreshNetworkStatusTooltip is a no-op when no indicator is on screen', () => {
    const container = renderWith();
    expect(() => refreshNetworkStatusTooltip(container, status())).not.toThrow();
    expect(container.querySelector('.net-status')).toBeNull();
  });
});

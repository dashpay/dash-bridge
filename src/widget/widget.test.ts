// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createIdentity, DashBridgeError, IFRAME_READY_TIMEOUT_MS, IFRAME_SANDBOX } from './index.js';
import { acceptBridgeEvent, buildBridgeUrl, generateRequestId } from './helpers.js';
import { buildMessage, isValidRequestId, type MessagePayloads, type MessageType } from '../embed/protocol.js';

const BRIDGE = 'https://bridge.example';
const IDENTITY_ID = '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('helpers', () => {
  it('generates protocol-valid, unique request IDs', () => {
    const a = generateRequestId();
    expect(isValidRequestId(a)).toBe(true);
    expect(a).toHaveLength(32);
    expect(generateRequestId()).not.toBe(a);
  });

  it('builds the bridge URL, keeping existing query params', () => {
    const url = buildBridgeUrl({
      bridgeUrl: `${BRIDGE}/?e2e=mock`,
      kind: 'iframe',
      origin: 'https://app.example',
      request: 'create-identity',
      network: 'mainnet',
      requestId: 'r1',
      appName: 'My App',
    });
    expect(Object.fromEntries(url.searchParams)).toEqual({
      e2e: 'mock',
      embed: 'iframe',
      origin: 'https://app.example',
      request: 'create-identity',
      network: 'mainnet',
      requestId: 'r1',
      app: 'My App',
    });
  });

  describe('acceptBridgeEvent', () => {
    const source = {};
    const expected = { origin: BRIDGE, source, request: 'create-identity' as const, requestId: 'r1' };
    const data = buildMessage('identity-created', { request: 'create-identity', requestId: 'r1' }, {
      identityId: IDENTITY_ID,
      network: 'testnet',
    });

    it('accepts a bridge message from the opened window', () => {
      expect(acceptBridgeEvent({ origin: BRIDGE, source: source as Window, data }, expected)).toEqual(data);
    });

    it('rejects the wrong origin', () => {
      expect(acceptBridgeEvent({ origin: 'https://evil.example', source: source as Window, data }, expected)).toBeNull();
    });

    it('rejects another window on the right origin', () => {
      expect(acceptBridgeEvent({ origin: BRIDGE, source: {} as Window, data }, expected)).toBeNull();
      expect(acceptBridgeEvent({ origin: BRIDGE, source: null, data }, { ...expected, source: null })).toBeNull();
    });

    it('rejects messages for another request', () => {
      expect(acceptBridgeEvent({ origin: BRIDGE, source: source as Window, data: { ...data, requestId: 'r2' } }, expected)).toBeNull();
    });
  });
});

/** Capture the bridge URL's requestId and dispatch messages "from" a window. */
function messenger(source: Window | null, url: () => string) {
  return <T extends MessageType>(type: T, payload: MessagePayloads[T], origin = BRIDGE) => {
    const requestId = new URL(url()).searchParams.get('requestId')!;
    const data = buildMessage(type, { request: 'create-identity', requestId }, payload);
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  };
}

describe('createIdentity (iframe)', () => {
  function setup(options: Parameters<typeof createIdentity>[0] = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const promise = createIdentity({ mode: 'iframe', container, bridgeUrl: `${BRIDGE}/`, ...options });
    const iframe = container.querySelector('iframe')!;
    const send = messenger(iframe.contentWindow, () => iframe.src);
    return { container, promise, iframe, send };
  }

  it('mounts a sandboxed iframe pointing at the bridge', () => {
    const { iframe, promise } = setup({ appName: 'Demo', network: 'mainnet' });
    promise.catch(() => {});
    const url = new URL(iframe.src);
    expect(url.origin).toBe(BRIDGE);
    expect(url.searchParams.get('embed')).toBe('iframe');
    expect(url.searchParams.get('origin')).toBe(window.location.origin);
    expect(url.searchParams.get('network')).toBe('mainnet');
    expect(url.searchParams.get('app')).toBe('Demo');
    expect(iframe.getAttribute('sandbox')).toBe(IFRAME_SANDBOX);
    expect(iframe.getAttribute('allow')).toBe('clipboard-write');
  });

  it('reports progress and resolves with the identity, then removes the iframe on close', async () => {
    const onProgress = vi.fn();
    const { promise, send, container } = setup({ onProgress });
    send('ready', {});
    send('progress', { step: 'awaiting_deposit' });
    send('identity-created', { identityId: IDENTITY_ID, network: 'testnet' });
    await expect(promise).resolves.toEqual({ identityId: IDENTITY_ID, network: 'testnet' });
    expect(onProgress).toHaveBeenCalledWith('awaiting_deposit');
    // The user still needs to save keys: the iframe stays until "close".
    expect(container.querySelector('iframe')).not.toBeNull();
    send('close', {});
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('ignores spoofed messages from other origins or windows', async () => {
    const { promise, send, iframe } = setup();
    send('identity-created', { identityId: 'spoofed', network: 'testnet' }, 'https://evil.example');
    messenger(window, () => iframe.src)('identity-created', { identityId: 'spoofed', network: 'testnet' });
    send('identity-created', { identityId: IDENTITY_ID, network: 'testnet' });
    await expect(promise).resolves.toEqual({ identityId: IDENTITY_ID, network: 'testnet' });
  });

  it('rejects with cancelled and removes the iframe', async () => {
    const { promise, send, container } = setup();
    send('cancelled', {});
    await expect(promise).rejects.toMatchObject({ name: 'DashBridgeError', code: 'cancelled' });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('passes recoverable errors to onError and rejects on fatal ones', async () => {
    const onError = vi.fn();
    const { promise, send } = setup({ onError });
    send('error', { code: 'ERR-1005', message: 'InstantSend lock failed', fatal: false });
    expect(onError).toHaveBeenCalledWith({ code: 'ERR-1005', message: 'InstantSend lock failed' });
    send('error', { code: 'unsupported_network', message: 'nope', fatal: true });
    await expect(promise).rejects.toMatchObject({ code: 'unsupported_network' });
  });

  it('aborts via AbortSignal', async () => {
    const controller = new AbortController();
    const { promise, container } = setup({ signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('removing the iframe before a result rejects with cancelled', async () => {
    vi.useFakeTimers();
    const { promise, iframe } = setup();
    iframe.remove();
    vi.advanceTimersByTime(600);
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('stops listening once the host removes the iframe after a result', async () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const { promise, iframe, send } = setup({ onProgress });
    send('identity-created', { identityId: IDENTITY_ID, network: 'testnet' });
    await expect(promise).resolves.toMatchObject({ identityId: IDENTITY_ID });
    const removeListener = vi.spyOn(window, 'removeEventListener');
    iframe.remove();
    vi.advanceTimersByTime(600);
    expect(removeListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('rejects with bridge_unavailable if the bridge never says ready', async () => {
    vi.useFakeTimers();
    const { promise, container } = setup();
    vi.advanceTimersByTime(IFRAME_READY_TIMEOUT_MS + 1);
    await expect(promise).rejects.toMatchObject({ code: 'bridge_unavailable' });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('does not time out once the bridge is ready', async () => {
    vi.useFakeTimers();
    const { promise, send } = setup();
    send('ready', {});
    vi.advanceTimersByTime(IFRAME_READY_TIMEOUT_MS + 1);
    send('identity-created', { identityId: IDENTITY_ID, network: 'testnet' });
    await expect(promise).resolves.toMatchObject({ identityId: IDENTITY_ID });
  });

  it('requires a container', async () => {
    await expect(createIdentity({ mode: 'iframe' })).rejects.toMatchObject({ code: 'invalid_options' });
  });
});

describe('createIdentity option checks', () => {
  type HappyWindow = { happyDOM: { setURL(url: string): void } };
  const setPageUrl = (url: string) => (window as unknown as HappyWindow).happyDOM.setURL(url);

  afterEach(() => setPageUrl('http://localhost:3000/'));

  it('rejects an app served over plain http on a public host (the bridge would refuse it)', async () => {
    setPageUrl('http://app.example/');
    const open = vi.spyOn(window, 'open');
    await expect(createIdentity({ bridgeUrl: BRIDGE })).rejects.toMatchObject({ code: 'invalid_options' });
    expect(open).not.toHaveBeenCalled();
  });

  it('accepts https apps', async () => {
    setPageUrl('https://app.example/');
    vi.spyOn(window, 'open').mockReturnValue(null);
    await expect(createIdentity({ bridgeUrl: BRIDGE })).rejects.toMatchObject({ code: 'popup_blocked' });
  });

  it('rejects a plain-http bridge URL on a public host', async () => {
    await expect(createIdentity({ bridgeUrl: 'http://bridge.example/' })).rejects.toMatchObject({
      code: 'invalid_options',
    });
  });
});

describe('createIdentity (popup)', () => {
  function fakePopup() {
    return { closed: false, close: vi.fn(function (this: { closed: boolean }) { this.closed = true; }) };
  }

  it('rejects with popup_blocked when window.open fails', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const error = await createIdentity({ bridgeUrl: BRIDGE }).catch((e) => e);
    expect(error).toBeInstanceOf(DashBridgeError);
    expect(error.code).toBe('popup_blocked');
  });

  it('opens a popup and resolves on identity-created', async () => {
    const popup = fakePopup();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const promise = createIdentity({ bridgeUrl: BRIDGE, network: 'testnet' });
    const [url, , features] = open.mock.calls[0] as [string, string, string];
    expect(new URL(url).searchParams.get('embed')).toBe('popup');
    expect(features).toContain('width=480');
    messenger(popup as unknown as Window, () => url)('identity-created', { identityId: IDENTITY_ID, network: 'testnet' });
    await expect(promise).resolves.toEqual({ identityId: IDENTITY_ID, network: 'testnet' });
    // The popup stays open so the user can save their keys.
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('rejects with cancelled when the user closes the popup', async () => {
    vi.useFakeTimers();
    const popup = fakePopup();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const promise = createIdentity({ bridgeUrl: BRIDGE });
    popup.closed = true;
    vi.advanceTimersByTime(600);
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
  });
});

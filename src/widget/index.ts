/**
 * Dash Bridge widget SDK.
 *
 * Lets a web app send the user to the Dash Bridge (popup or iframe) to create
 * a Platform identity and get the identity ID back. The bridge keeps the
 * mnemonic and keys; the app only ever receives the result fields.
 *
 * Built as `dist/widget.js` (IIFE, global `DashBridge`) and `dist/widget.mjs`.
 * Must stay dependency-free apart from the shared protocol module.
 */
import {
  PROTOCOL_VERSION,
  type BridgeMessage,
  type EmbedKind,
  type EmbedNetwork,
  type EmbedRequestType,
  type ProgressStep,
} from '../embed/protocol.js';
import { acceptBridgeEvent, buildBridgeUrl, generateRequestId } from './helpers.js';

export { PROTOCOL_VERSION };
export type { ProgressStep, EmbedNetwork, EmbedKind };

export const DEFAULT_BRIDGE_URL = 'https://bridge.thepasta.org/';

const POPUP_WIDTH = 480;
const POPUP_HEIGHT = 760;
const POPUP_CLOSED_POLL_MS = 500;
const IFRAME_HEIGHT = '760px';
/** See docs/widget.md: what the bridge needs inside a sandboxed iframe. */
export const IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals';
export const IFRAME_ALLOW = 'clipboard-write';

/**
 * - `popup_blocked`: the browser blocked the popup (call from a click handler).
 * - `cancelled`: the user cancelled or closed the bridge.
 * - `aborted`: the caller's AbortSignal fired.
 * - `invalid_options`: bad arguments.
 * - anything else: a fatal error code reported by the bridge
 *   (e.g. `unsupported_network`, `unsupported_request`).
 */
export type DashBridgeErrorCode =
  | 'popup_blocked'
  | 'cancelled'
  | 'aborted'
  | 'invalid_options'
  | (string & {});

export class DashBridgeError extends Error {
  readonly code: DashBridgeErrorCode;

  constructor(code: DashBridgeErrorCode, message: string) {
    super(message);
    this.name = 'DashBridgeError';
    this.code = code;
  }
}

/** A recoverable error shown in the bridge; the user may still retry there. */
export interface BridgeErrorInfo {
  code: string;
  message: string;
}

export interface BridgeRequestOptions {
  /** Defaults to `'testnet'`. */
  network?: EmbedNetwork;
  /** `'popup'` (default, recommended) or `'iframe'`. */
  mode?: EmbedKind;
  /** iframe mode: element the iframe is appended to. */
  container?: HTMLElement;
  /** Name shown to the user in the bridge (max 64 chars). */
  appName?: string;
  /** Defaults to `https://bridge.thepasta.org/`. */
  bridgeUrl?: string;
  onProgress?: (step: ProgressStep) => void;
  /** Recoverable errors; the promise keeps waiting. */
  onError?: (error: BridgeErrorInfo) => void;
  /** Abort the request (closes the popup / removes the iframe). */
  signal?: AbortSignal;
}

export type CreateIdentityOptions = BridgeRequestOptions;

export interface CreateIdentityResult {
  identityId: string;
  network: string;
}

/**
 * Open the bridge and resolve with the new identity once it is registered.
 * In popup mode, call this synchronously from a user gesture (click).
 */
export function createIdentity(options: CreateIdentityOptions = {}): Promise<CreateIdentityResult> {
  return runBridgeRequest('create-identity', options, (msg) =>
    msg.type === 'identity-created' ? { identityId: msg.identityId, network: msg.network } : undefined,
  );
}

function safeCall<A>(fn: ((arg: A) => void) | undefined, arg: A): void {
  if (!fn) return;
  try {
    fn(arg);
  } catch (err) {
    console.error('DashBridge callback threw:', err);
  }
}

/**
 * Shared lifecycle for every request type: open the bridge, route messages,
 * and clean up. `extractResult` turns the request's result message into the
 * resolved value.
 */
function runBridgeRequest<R>(
  request: EmbedRequestType,
  options: BridgeRequestOptions,
  extractResult: (msg: BridgeMessage) => R | undefined,
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const mode = options.mode ?? 'popup';
    const network = options.network ?? 'testnet';
    const invalid = (message: string) => reject(new DashBridgeError('invalid_options', message));

    if (mode !== 'popup' && mode !== 'iframe') return invalid('mode must be "popup" or "iframe"');
    if (network !== 'mainnet' && network !== 'testnet') return invalid('network must be "mainnet" or "testnet"');
    if (mode === 'iframe' && !(options.container instanceof HTMLElement)) {
      return invalid('iframe mode needs a container element');
    }
    const origin = window.location.origin;
    if (!origin || origin === 'null') return invalid('the app must be served from an http(s) origin');

    let bridgeUrl: URL;
    try {
      bridgeUrl = new URL(options.bridgeUrl ?? DEFAULT_BRIDGE_URL, window.location.href);
    } catch {
      return invalid('bridgeUrl is not a valid URL');
    }
    if (bridgeUrl.protocol !== 'https:' && bridgeUrl.protocol !== 'http:') {
      return invalid('bridgeUrl must be http(s)');
    }
    if (options.signal?.aborted) {
      return reject(new DashBridgeError('aborted', 'The request was aborted.'));
    }

    const requestId = generateRequestId();
    const url = buildBridgeUrl({
      bridgeUrl: bridgeUrl.href,
      kind: mode,
      origin,
      request,
      network,
      requestId,
      appName: options.appName?.slice(0, 64),
    });
    const bridgeOrigin = bridgeUrl.origin;

    let popup: Window | null = null;
    let iframe: HTMLIFrameElement | null = null;
    let target: Window | null = null;

    if (mode === 'popup') {
      // Must happen synchronously inside the user gesture.
      const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2));
      const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2));
      popup = window.open(
        url.href,
        `dash-bridge-${requestId}`,
        `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`,
      );
      if (!popup) {
        return reject(new DashBridgeError('popup_blocked', 'The browser blocked the Dash Bridge popup.'));
      }
      target = popup;
    } else {
      iframe = document.createElement('iframe');
      iframe.src = url.href;
      iframe.title = 'Dash Bridge';
      iframe.setAttribute('sandbox', IFRAME_SANDBOX);
      iframe.setAttribute('allow', IFRAME_ALLOW);
      // Lets the bridge cross-check the embedding origin where
      // location.ancestorOrigins is unavailable.
      iframe.referrerPolicy = 'origin';
      iframe.style.cssText = `width:100%;height:${IFRAME_HEIGHT};border:0;display:block;`;
      options.container!.appendChild(iframe);
      target = iframe.contentWindow;
    }

    let settled = false;
    let closedTimer: ReturnType<typeof setInterval> | undefined;

    const removeIframe = () => {
      iframe?.remove();
      iframe = null;
    };

    const stopListening = () => {
      window.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
      if (closedTimer !== undefined) clearInterval(closedTimer);
      closedTimer = undefined;
    };

    /** Final cleanup: no more messages, iframe removed. */
    const teardown = () => {
      stopListening();
      removeIframe();
    };

    const fail = (error: DashBridgeError, closeBridge: boolean) => {
      if (settled) return;
      settled = true;
      teardown();
      if (closeBridge && popup && !popup.closed) popup.close();
      reject(error);
    };

    const succeed = (result: R) => {
      if (settled) return;
      settled = true;
      resolve(result);
      // The user still has to save their keys: the popup stays open, and the
      // iframe stays until the bridge asks to close (or the signal aborts).
      if (!iframe) stopListening();
      else if (closedTimer !== undefined) clearInterval(closedTimer);
    };

    function onAbort() {
      if (settled) teardown();
      else fail(new DashBridgeError('aborted', 'The request was aborted.'), true);
    }

    function onMessage(event: MessageEvent) {
      const msg = acceptBridgeEvent(event, { origin: bridgeOrigin, source: target, request, requestId });
      if (!msg) return;
      switch (msg.type) {
        case 'progress':
          if (!settled) safeCall(options.onProgress, msg.step);
          return;
        case 'error':
          if (msg.fatal) fail(new DashBridgeError(msg.code, msg.message), false);
          else if (!settled) safeCall(options.onError, { code: msg.code, message: msg.message });
          return;
        case 'cancelled':
        case 'close':
          if (settled) teardown();
          else fail(new DashBridgeError('cancelled', 'The user cancelled the request.'), false);
          return;
        default: {
          const result = extractResult(msg);
          if (result !== undefined) succeed(result);
        }
      }
    }

    window.addEventListener('message', onMessage);
    options.signal?.addEventListener('abort', onAbort);
    if (popup) {
      const watched = popup;
      closedTimer = setInterval(() => {
        if (watched.closed) fail(new DashBridgeError('cancelled', 'The Dash Bridge window was closed.'), false);
      }, POPUP_CLOSED_POLL_MS);
    }
  });
}

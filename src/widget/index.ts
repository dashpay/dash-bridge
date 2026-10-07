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
  EMBED_KINDS,
  EMBED_NETWORKS,
  isAllowedWebUrl,
  isOneOf,
  parseRequestOrigin,
  sanitizeAppName,
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
/** How often to check whether the popup was closed / the iframe removed. */
const WATCH_INTERVAL_MS = 500;
/** iframe mode: give up if the bridge never says `ready` (e.g. it refused the request). */
export const IFRAME_READY_TIMEOUT_MS = 30_000;
const IFRAME_HEIGHT = '760px';
/** See docs/widget.md: what the bridge needs inside a sandboxed iframe. */
export const IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals';
export const IFRAME_ALLOW = 'clipboard-write';

/**
 * - `popup_blocked`: the browser blocked the popup (call from a click handler).
 * - `cancelled`: the user cancelled, closed the popup, or the iframe was removed.
 * - `aborted`: the caller's AbortSignal fired.
 * - `invalid_options`: bad arguments, or the page/bridge URL is not https
 *   (http is allowed only on localhost).
 * - `bridge_unavailable`: iframe mode, the bridge did not load or refused the
 *   request (it shows the reason inside the iframe).
 * - anything else: a fatal error code reported by the bridge
 *   (e.g. `unsupported_network`, `unsupported_request`).
 */
export type DashBridgeErrorCode =
  | 'popup_blocked'
  | 'cancelled'
  | 'aborted'
  | 'invalid_options'
  | 'bridge_unavailable'
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
  /** Name shown to the user in the bridge (max 64 characters). */
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

    if (!isOneOf(EMBED_KINDS, mode)) return invalid('mode must be "popup" or "iframe"');
    if (!isOneOf(EMBED_NETWORKS, network)) return invalid('network must be "mainnet" or "testnet"');
    if (mode === 'iframe' && !(options.container instanceof HTMLElement)) {
      return invalid('iframe mode needs a container element');
    }
    // Same rule the bridge applies, so it never silently refuses us.
    const origin = parseRequestOrigin(window.location.origin);
    if (!origin) return invalid('the app must be served over https (http only on localhost)');

    let bridgeUrl: URL;
    try {
      bridgeUrl = new URL(options.bridgeUrl ?? DEFAULT_BRIDGE_URL, window.location.href);
    } catch {
      return invalid('bridgeUrl is not a valid URL');
    }
    if (!isAllowedWebUrl(bridgeUrl)) return invalid('bridgeUrl must be https (http only on localhost)');
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
      appName: sanitizeAppName(options.appName),
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
      // Lets the bridge check the embedding origin where
      // location.ancestorOrigins is unavailable.
      iframe.referrerPolicy = 'origin';
      iframe.style.cssText = `width:100%;height:${IFRAME_HEIGHT};border:0;display:block;`;
      options.container!.appendChild(iframe);
      target = iframe.contentWindow;
    }

    let settled = false;
    let watchTimer: ReturnType<typeof setInterval> | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;

    /** Final cleanup: no more messages, timers stopped, iframe removed. */
    const teardown = () => {
      window.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
      clearInterval(watchTimer);
      clearTimeout(readyTimer);
      iframe?.remove();
      iframe = null;
    };

    const fail = (code: DashBridgeErrorCode, message: string, closePopup = false) => {
      if (settled) return;
      settled = true;
      teardown();
      if (closePopup && popup && !popup.closed) popup.close();
      reject(new DashBridgeError(code, message));
    };

    const succeed = (result: R) => {
      if (settled) return;
      settled = true;
      resolve(result);
      // The user still has to save their keys. The popup stays open and we're
      // done with it; the iframe stays until the bridge asks to close, the
      // host removes it, or the signal aborts.
      if (popup) teardown();
    };

    function onAbort() {
      if (settled) teardown();
      else fail('aborted', 'The request was aborted.', true);
    }

    function onMessage(event: MessageEvent) {
      const msg = acceptBridgeEvent(event, { origin: bridgeOrigin, source: target, request, requestId });
      if (!msg) return;
      switch (msg.type) {
        case 'ready':
          clearTimeout(readyTimer);
          return;
        case 'progress':
          if (!settled) safeCall(options.onProgress, msg.step);
          return;
        case 'error':
          if (msg.fatal) fail(msg.code, msg.message);
          else if (!settled) safeCall(options.onError, { code: msg.code, message: msg.message });
          return;
        case 'cancelled':
        case 'close':
          if (settled) teardown();
          else fail('cancelled', 'The user cancelled the request.');
          return;
        default: {
          const result = extractResult(msg);
          if (result !== undefined) succeed(result);
        }
      }
    }

    window.addEventListener('message', onMessage);
    options.signal?.addEventListener('abort', onAbort);
    watchTimer = setInterval(() => {
      const gone = popup ? popup.closed : !iframe?.isConnected;
      if (!gone) return;
      if (settled) teardown();
      else fail('cancelled', popup ? 'The Dash Bridge window was closed.' : 'The Dash Bridge iframe was removed.');
    }, WATCH_INTERVAL_MS);
    if (iframe) {
      readyTimer = setTimeout(
        () => fail('bridge_unavailable', 'The Dash Bridge did not load or refused the request.'),
        IFRAME_READY_TIMEOUT_MS,
      );
    }
  });
}

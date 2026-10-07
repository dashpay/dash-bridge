/**
 * Bridge side of embed mode: a third-party app opens the bridge in a popup or
 * iframe (see docs/widget.md) and receives the new identity ID back via
 * postMessage. Keys and the mnemonic never leave this window.
 */
import type { BridgeState, BridgeStep, EmbedDisplay, EmbedNotice } from '../types.js';
import { ErrorCodeLabels } from '../ui/state.js';
import {
  buildMessage,
  parseEmbedParams,
  type EmbedNetwork,
  type EmbedParams,
  type MessagePayloads,
  type MessageType,
  type ProgressStep,
  type UnsupportedEmbedParams,
} from './protocol.js';

export type EmbedResolution =
  | { action: 'run'; session?: EmbedSession }
  | { action: 'block'; notice: EmbedNotice };

const CANCEL_AFTER_DEPOSIT_PROMPT =
  'If you already sent DASH to the deposit address, cancelling leaves it locked ' +
  'until you recover it with your key backup. Cancel anyway?';

export const EXPIRED_NOTICE: EmbedNotice = {
  title: 'Request expired',
  message: 'This window is no longer connected to the app that opened it. Return to the app and try again.',
};

const CANCELLED_NOTICE: EmbedNotice = {
  title: 'Request cancelled',
  message: 'Nothing was shared with the app.',
};

/** Steps where the identity may already be on its way to Platform: no cancelling. */
const NON_CANCELLABLE_STEPS: readonly BridgeStep[] = ['registering_identity', 'complete'];

export function canCancel(step: BridgeStep): boolean {
  return !NON_CANCELLABLE_STEPS.includes(step);
}

/** Map internal UI steps of the create flow to the coarse public progress steps. */
export function toProgressStep(step: BridgeStep): ProgressStep | undefined {
  switch (step) {
    case 'configure_keys':
    case 'generating_keys':
      return 'configuring';
    case 'awaiting_deposit':
    case 'detecting_deposit':
      return 'awaiting_deposit';
    case 'building_transaction':
    case 'signing_transaction':
    case 'broadcasting':
    case 'waiting_islock':
    case 'waiting_chainlock':
      return 'processing';
    case 'registering_identity':
      return 'registering';
    case 'complete':
      return 'complete';
    case 'error':
      return 'error';
    default:
      return undefined;
  }
}

function isFramed(win: Window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

/**
 * Standalone bridge URL for "open in a new window" links. Built from scratch
 * (keeping only the network) so a framer can't smuggle deep-link params.
 */
function standaloneHref(win: Window): string {
  const current = new URL(win.location.href);
  const url = new URL('/', current.origin);
  const network = current.searchParams.get('network');
  if (network) url.searchParams.set('network', network);
  return url.toString();
}

/**
 * Origin of the page framing us, when the browser tells us. Chromium/WebKit
 * expose `location.ancestorOrigins`; elsewhere fall back to the referrer.
 */
function framingOrigin(win: Window): string | undefined {
  const ancestors = win.location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) return ancestors[0];
  const referrer = win.document.referrer;
  if (!referrer) return undefined;
  try {
    return new URL(referrer).origin;
  } catch {
    return undefined;
  }
}

/** A reload or history navigation can't resume a request: its state is gone. */
function isRevisit(win: Window): boolean {
  const entry = win.performance?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  return entry?.type === 'reload' || entry?.type === 'back_forward';
}

function block(title: string, message: string, openHref?: string): EmbedResolution {
  return { action: 'block', notice: { title, message, openHref } };
}

/**
 * Decide how the page may run, given its URL and how it is framed. Returns an
 * embed session when the bridge was opened by an app.
 */
export function resolveEmbed(win: Window = window): EmbedResolution {
  const parsed = parseEmbedParams(win.location.search);
  const framed = isFramed(win);

  // Clickjacking guard: only an iframe embed may be framed. (Invalid iframe
  // requests fall through so the user sees the actual reason.)
  if (framed && new URLSearchParams(win.location.search).get('embed') !== 'iframe') {
    return block(
      "This page can't run inside another site",
      'For your security, the Dash Bridge only runs in its own window.',
      standaloneHref(win),
    );
  }

  if (parsed.status === 'none') return { action: 'run' };
  if (parsed.status === 'invalid') {
    return block('Invalid request', `${parsed.reason} Return to the app and try again.`);
  }
  if (isRevisit(win)) return { action: 'block', notice: EXPIRED_NOTICE };

  const params = parsed.params;
  if (params.kind === 'iframe') {
    if (!framed) {
      return block('Nothing to embed', 'This link is meant to be embedded by another app.', standaloneHref(win));
    }
    // Unknown framer (no ancestorOrigins, no referrer) is refused too: the
    // banner would otherwise vouch for an origin nobody checked.
    if (framingOrigin(win) !== params.origin) {
      return block(
        'Request refused',
        "The bridge couldn't confirm that the page embedding it is the app it claims to be.",
        standaloneHref(win),
      );
    }
  } else if (!win.opener) {
    return { action: 'block', notice: EXPIRED_NOTICE };
  }

  const session = new EmbedSession(params, win);
  if (parsed.status === 'unsupported') {
    session.failFatal(parsed.code, parsed.reason);
    return block('Unsupported request', parsed.reason);
  }
  return { action: 'run', session };
}

/**
 * Talks to the app that opened/framed the bridge. Messages go only to the
 * declared origin (never `'*'`), and payloads are whitelisted by
 * `buildMessage`, so secrets cannot be posted.
 */
export class EmbedSession {
  readonly display: EmbedDisplay;
  readonly network: EmbedNetwork;
  /** When set, the app UI is replaced by this notice (cancelled / expired). */
  notice: EmbedNotice | undefined;
  private lastProgress: ProgressStep | undefined;
  private finished = false;

  constructor(
    private readonly params: EmbedParams | UnsupportedEmbedParams,
    private readonly win: Window,
  ) {
    this.display = { kind: params.kind, origin: params.origin, appName: params.appName };
    this.network = 'network' in params ? params.network : 'testnet';
  }

  private target(): Window | null {
    const target = this.params.kind === 'popup' ? this.win.opener : this.win.parent;
    return target && target !== this.win ? (target as Window) : null;
  }

  private post<T extends MessageType>(type: T, payload: MessagePayloads[T]): void {
    const target = this.target();
    if (!target) return;
    const message = buildMessage(type, { request: this.params.request, requestId: this.params.requestId }, payload);
    try {
      target.postMessage(message, this.params.origin);
    } catch (err) {
      console.warn('Could not message the requesting app:', err);
    }
  }

  /** Post a terminal message; at most one per session. */
  private finish<T extends MessageType>(type: T, payload: MessagePayloads[T]): boolean {
    if (this.finished) return false;
    this.finished = true;
    this.post(type, payload);
    return true;
  }

  /** Announce that the bridge loaded, with the initial progress step. */
  start(state: BridgeState): void {
    this.post('ready', {});
    this.onStateChange(undefined, state);
  }

  /** Report progress, the result, or an error after each state change. */
  onStateChange(prev: BridgeState | undefined, next: BridgeState): void {
    // Nothing more to report once the request is settled.
    if (this.finished) return;

    const step = toProgressStep(next.step);
    if (step && step !== this.lastProgress) {
      this.lastProgress = step;
      this.post('progress', { step });
    }

    if (next.step === 'error' && prev?.step !== 'error') {
      const code = next.errorCode ?? 'ERR-UNKNOWN';
      // Only the static label: raw error text can carry arbitrary detail.
      this.post('error', { code, message: ErrorCodeLabels[code] ?? 'Unexpected error', fatal: false });
    }

    if (
      this.params.request === 'create-identity' &&
      next.mode === 'create' &&
      next.step === 'complete' &&
      next.identityId
    ) {
      this.finish('identity-created', { identityId: next.identityId, network: next.network });
    }
  }

  /** Report a request the bridge cannot serve. */
  failFatal(code: string, message: string): void {
    this.finish('error', { code, message, fatal: true });
  }

  /**
   * User pressed Cancel. Asks for confirmation once funds may be in flight.
   * Returns false if nothing was cancelled.
   */
  cancel(state: BridgeState, confirm: (message: string) => boolean = (m) => this.win.confirm(m)): boolean {
    if (this.finished || !canCancel(state.step)) return false;
    if (state.assetLockKeyPair && !confirm(CANCEL_AFTER_DEPOSIT_PROMPT)) return false;
    this.finish('cancelled', {});
    // The popup closes; an iframe host may not remove us, so stop the flow UI.
    if (this.params.kind === 'popup') this.win.close();
    this.notice = CANCELLED_NOTICE;
    return true;
  }

  /** "Return to app" on the complete screen. */
  returnToApp(): void {
    if (this.params.kind === 'popup') {
      this.win.close();
    } else {
      this.post('close', {});
    }
  }

  /**
   * iframe mode, best effort: the frame is going away before a result. Popups
   * don't do this: a reload would orphan the request, and the SDK already
   * notices a closed popup.
   */
  handlePageHide(): void {
    if (this.params.kind === 'iframe') this.finish('cancelled', {});
  }

  /** Restored from the back/forward cache: the app has moved on. */
  expire(): void {
    this.finished = true;
    this.notice = EXPIRED_NOTICE;
  }
}

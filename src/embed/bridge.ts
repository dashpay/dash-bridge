/**
 * Bridge side of embed mode: a third-party app opens the bridge in a popup or
 * iframe (see docs/widget.md) and receives the new identity ID back via
 * postMessage. Keys and the mnemonic never leave this window.
 */
import type { BridgeState, BridgeStep, EmbedDisplay } from '../types.js';
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

/** Message shown instead of the app when it must not run in this context. */
export interface EmbedNotice {
  title: string;
  message: string;
  /** Offer a link that opens the standalone bridge in a new tab. */
  openHref?: string;
}

export type EmbedResolution =
  | { action: 'run'; session?: EmbedSession }
  | { action: 'block'; notice: EmbedNotice };

const EMBED_PARAM_NAMES = ['embed', 'origin', 'app', 'request', 'requestId'];

const CANCEL_AFTER_DEPOSIT_PROMPT =
  'If you already sent DASH to the deposit address, cancelling leaves it locked ' +
  'until you recover it with your key backup. Cancel anyway?';

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

/** The current URL without embed parameters, for "open in a new window" links. */
function standaloneHref(win: Window): string {
  const url = new URL(win.location.href);
  for (const name of EMBED_PARAM_NAMES) url.searchParams.delete(name);
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

/**
 * Decide how the page may run, given its URL and how it is framed. Returns an
 * embed session when the bridge was opened by an app.
 */
export function resolveEmbed(win: Window = window): EmbedResolution {
  const parsed = parseEmbedParams(win.location.search);
  const framed = isFramed(win);
  const kind = parsed.status === 'ok' || parsed.status === 'unsupported' ? parsed.params.kind : undefined;

  // Clickjacking guard: only an explicit, validated iframe embed may be framed.
  if (framed && kind !== 'iframe') {
    return {
      action: 'block',
      notice: {
        title: "This page can't run inside another site",
        message: 'For your security, the Dash Bridge only runs in its own window.',
        openHref: standaloneHref(win),
      },
    };
  }

  if (parsed.status === 'none') return { action: 'run' };
  if (parsed.status === 'invalid') {
    return {
      action: 'block',
      notice: {
        title: 'Invalid request',
        message: `${parsed.reason} Return to the app and try again.`,
      },
    };
  }

  const params = parsed.params;
  if (params.kind === 'iframe') {
    if (!framed) {
      return {
        action: 'block',
        notice: {
          title: 'Nothing to embed',
          message: 'This link is meant to be embedded by another app.',
          openHref: standaloneHref(win),
        },
      };
    }
    const actual = framingOrigin(win);
    if (actual !== undefined && actual !== params.origin) {
      return {
        action: 'block',
        notice: {
          title: 'Request refused',
          message: "The page embedding the bridge doesn't match the origin it declared.",
          openHref: standaloneHref(win),
        },
      };
    }
  } else if (!win.opener) {
    return {
      action: 'block',
      notice: {
        title: 'Request expired',
        message: 'This window is no longer connected to the app that opened it. Return to the app and try again.',
      },
    };
  }

  const session = new EmbedSession(params, win);
  if (parsed.status === 'unsupported') {
    session.failFatal(parsed.code, parsed.reason);
    return { action: 'block', notice: { title: 'Unsupported request', message: parsed.reason } };
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
      this.finished = true;
      this.post('identity-created', { identityId: next.identityId, network: next.network });
    }
  }

  /** Report a request the bridge cannot serve. */
  failFatal(code: string, message: string): void {
    if (this.finished) return;
    this.finished = true;
    this.post('error', { code, message, fatal: true });
  }

  /**
   * User pressed Cancel. Asks for confirmation once funds may be in flight.
   * Returns false if the user backed out.
   */
  cancel(state: BridgeState, confirm: (message: string) => boolean = (m) => this.win.confirm(m)): boolean {
    if (this.finished) return false;
    if (state.assetLockKeyPair && state.step !== 'complete' && !confirm(CANCEL_AFTER_DEPOSIT_PROMPT)) {
      return false;
    }
    this.finished = true;
    this.post('cancelled', {});
    if (this.params.kind === 'popup') this.win.close();
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

  /** Best effort: tell the app the window is going away before a result. */
  handlePageHide(): void {
    if (this.finished) return;
    this.finished = true;
    this.post('cancelled', {});
  }
}

/**
 * Message protocol shared by the bridge (embed mode) and the `widget.js` SDK.
 *
 * Every message the bridge posts is a plain object with a fixed envelope
 * (`source`, `version`, `type`, `request`, optional `requestId`) plus a small,
 * whitelisted payload. Payloads are built field by field from known keys so
 * nothing else (mnemonic, WIFs, key backup) can ride along by accident.
 *
 * This module must stay dependency-free: the SDK bundles it.
 */

export const PROTOCOL_SOURCE = 'dash-bridge';
export const PROTOCOL_VERSION = 1;

/** How the requesting app hosts the bridge. */
export const EMBED_KINDS = ['popup', 'iframe'] as const;
export type EmbedKind = (typeof EMBED_KINDS)[number];

/**
 * What the app asked the bridge to do. Each request type has its own result
 * message; the envelope, origin handling and lifecycle messages are shared.
 */
export const EMBED_REQUEST_TYPES = ['create-identity'] as const;
export type EmbedRequestType = (typeof EMBED_REQUEST_TYPES)[number];
export const DEFAULT_REQUEST_TYPE: EmbedRequestType = 'create-identity';

export const EMBED_NETWORKS = ['mainnet', 'testnet'] as const;
export type EmbedNetwork = (typeof EMBED_NETWORKS)[number];

/** Coarse, stable progress steps exposed to apps (decoupled from internal UI steps). */
export const PROGRESS_STEPS = [
  'configuring',
  'awaiting_deposit',
  'processing',
  'registering',
  'complete',
  'error',
] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];

export const MAX_APP_NAME_LENGTH = 64;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_TYPE_PATTERN = /^[a-z0-9-]{1,32}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Type guard: `value` is one of the literals in `list`. */
export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value);
}

/** Payload per message type. Only these keys are ever emitted. */
export interface MessagePayloads {
  /** The bridge loaded and accepted the request. */
  ready: Record<string, never>;
  /** The flow moved to a new coarse step. */
  progress: { step: ProgressStep };
  /** `create-identity` result: the identity is registered on Platform. */
  'identity-created': { identityId: string; network: string };
  /**
   * Something went wrong. `fatal: true` means the request cannot proceed
   * (e.g. unsupported network); otherwise the user can still retry or recover
   * inside the bridge, so apps should keep waiting.
   */
  error: { code: string; message: string; fatal: boolean };
  /** The user cancelled or closed the bridge before finishing. */
  cancelled: Record<string, never>;
  /** iframe mode: the user is done; the app should remove the iframe. */
  close: Record<string, never>;
}

export type MessageType = keyof MessagePayloads;

const PAYLOAD_FIELDS: { [T in MessageType]: readonly (keyof MessagePayloads[T])[] } = {
  ready: [],
  progress: ['step'],
  'identity-created': ['identityId', 'network'],
  error: ['code', 'message', 'fatal'],
  cancelled: [],
  close: [],
};

export const MESSAGE_TYPES = Object.keys(PAYLOAD_FIELDS) as MessageType[];

export interface MessageEnvelope<T extends MessageType = MessageType> {
  source: typeof PROTOCOL_SOURCE;
  version: typeof PROTOCOL_VERSION;
  type: T;
  /** Echo of the request type (a known EmbedRequestType, or the raw value when unsupported). */
  request: string;
  requestId?: string;
}

export type BridgeMessageOf<T extends MessageType> = MessageEnvelope<T> & MessagePayloads[T];

/** Discriminated union of every bridge message (narrow on `type`). */
export type BridgeMessage = { [T in MessageType]: BridgeMessageOf<T> }[MessageType];

/**
 * Build an outbound message. Copies only the whitelisted payload fields for
 * `type`, so extra properties on `payload` are dropped.
 */
export function buildMessage<T extends MessageType>(
  type: T,
  ctx: Pick<MessageEnvelope, 'request' | 'requestId'>,
  payload: MessagePayloads[T],
): BridgeMessageOf<T> {
  const message: Record<string, unknown> = {
    source: PROTOCOL_SOURCE,
    version: PROTOCOL_VERSION,
    type,
    request: ctx.request,
  };
  if (ctx.requestId !== undefined) message.requestId = ctx.requestId;
  const source = payload as Record<string, unknown>;
  for (const field of PAYLOAD_FIELDS[type] as readonly string[]) {
    message[field] = source[field];
  }
  return message as BridgeMessageOf<T>;
}

/**
 * Validate an inbound message on the SDK side. Origin and source-window checks
 * happen on the MessageEvent before this is called.
 */
export function parseBridgeMessage(
  data: unknown,
  expected: { request: EmbedRequestType; requestId: string },
): BridgeMessage | null {
  if (!data || typeof data !== 'object') return null;
  const msg = data as Record<string, unknown>;
  if (msg.source !== PROTOCOL_SOURCE || msg.version !== PROTOCOL_VERSION) return null;
  if (!isOneOf(MESSAGE_TYPES, msg.type)) return null;
  if (msg.request !== expected.request || msg.requestId !== expected.requestId) return null;

  switch (msg.type) {
    case 'progress':
      if (!isOneOf(PROGRESS_STEPS, msg.step)) return null;
      break;
    case 'identity-created':
      if (typeof msg.identityId !== 'string' || typeof msg.network !== 'string') return null;
      break;
    case 'error':
      if (typeof msg.code !== 'string' || typeof msg.message !== 'string' || typeof msg.fatal !== 'boolean') {
        return null;
      }
      break;
  }
  return msg as unknown as BridgeMessage;
}

/** https anywhere, or http on a loopback host (local development). */
export function isAllowedWebUrl(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

/**
 * Return `value` if it is a bare web origin (scheme://host[:port], nothing
 * else) that may receive bridge messages: https, or http on a loopback host.
 */
export function parseRequestOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin === 'null' || url.origin !== value) return null;
  return isAllowedWebUrl(url) ? url.origin : null;
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/**
 * Trim, drop control and format characters (including bidi overrides that
 * could visually reorder the origin next to it) and cap the length of an app
 * display name, counting code points so surrogate pairs stay intact.
 */
export function sanitizeAppName(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const stripped = value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  const cleaned = Array.from(stripped).slice(0, MAX_APP_NAME_LENGTH).join('').trim();
  // A name that looks like a URL could pass for a different origin next to
  // the real one in the banner; show only the verified origin instead.
  if (cleaned.includes('://')) return undefined;
  return cleaned || undefined;
}

export interface EmbedParams {
  kind: EmbedKind;
  origin: string;
  request: EmbedRequestType;
  network: EmbedNetwork;
  appName?: string;
  requestId?: string;
}

/** Enough of a request to reply to the app with a fatal error. */
export interface UnsupportedEmbedParams {
  kind: EmbedKind;
  origin: string;
  /** Raw request type, echoed so the SDK can match the reply. */
  request: string;
  appName?: string;
  requestId?: string;
}

export type EmbedParamsResult =
  | { status: 'none' }
  | { status: 'invalid'; reason: string }
  /** Parsed well enough to reply to the app, but the request can't be served. */
  | { status: 'unsupported'; params: UnsupportedEmbedParams; code: string; reason: string }
  | { status: 'ok'; params: EmbedParams };

/** Parse embed-mode URL parameters. */
export function parseEmbedParams(search: string | URLSearchParams): EmbedParamsResult {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const embed = q.get('embed');
  if (embed === null) return { status: 'none' };
  const invalid = (reason: string): EmbedParamsResult => ({ status: 'invalid', reason });

  if (!isOneOf(EMBED_KINDS, embed)) return invalid('Unknown embed mode.');
  const origin = parseRequestOrigin(q.get('origin'));
  if (!origin) return invalid('The requesting app did not provide a valid origin.');
  const rawRequestId = q.get('requestId');
  if (rawRequestId !== null && !isValidRequestId(rawRequestId)) return invalid('Invalid request ID.');
  const request = q.get('request') ?? DEFAULT_REQUEST_TYPE;
  if (!REQUEST_TYPE_PATTERN.test(request)) return invalid('Invalid request type.');

  const base = {
    kind: embed,
    origin,
    appName: sanitizeAppName(q.get('app')),
    requestId: rawRequestId ?? undefined,
  };
  const unsupported = (code: string, reason: string): EmbedParamsResult => ({
    status: 'unsupported',
    params: { ...base, request },
    code,
    reason,
  });

  if (!isOneOf(EMBED_REQUEST_TYPES, request)) {
    return unsupported('unsupported_request', 'This bridge does not support the requested operation.');
  }
  const network = q.get('network') ?? 'testnet';
  if (!isOneOf(EMBED_NETWORKS, network)) {
    return unsupported('unsupported_network', 'Only mainnet and testnet are supported in embedded mode.');
  }
  return { status: 'ok', params: { ...base, request, network } };
}

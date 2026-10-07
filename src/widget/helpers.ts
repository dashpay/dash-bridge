/** Internal SDK helpers (exported for unit tests, not part of the public API). */
import {
  parseBridgeMessage,
  type BridgeMessage,
  type EmbedKind,
  type EmbedNetwork,
  type EmbedRequestType,
} from '../embed/protocol.js';

/** Random request ID matching the protocol's `[A-Za-z0-9_-]{1,64}`. */
export function generateRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build the bridge URL for a request. */
export function buildBridgeUrl(params: {
  bridgeUrl: string;
  kind: EmbedKind;
  origin: string;
  request: EmbedRequestType;
  network: EmbedNetwork;
  requestId: string;
  appName?: string;
}): URL {
  const url = new URL(params.bridgeUrl);
  url.searchParams.set('embed', params.kind);
  url.searchParams.set('origin', params.origin);
  url.searchParams.set('request', params.request);
  url.searchParams.set('network', params.network);
  url.searchParams.set('requestId', params.requestId);
  if (params.appName) url.searchParams.set('app', params.appName);
  return url;
}

/**
 * Accept a MessageEvent only if it comes from the bridge window we opened,
 * on the bridge origin, and belongs to this request.
 */
export function acceptBridgeEvent(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  expected: { origin: string; source: unknown; request: EmbedRequestType; requestId: string },
): BridgeMessage | null {
  if (event.origin !== expected.origin) return null;
  if (!expected.source || event.source !== expected.source) return null;
  return parseBridgeMessage(event.data, { request: expected.request, requestId: expected.requestId });
}

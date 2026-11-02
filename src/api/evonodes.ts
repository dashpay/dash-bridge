import { fetchJson } from '../utils/fetch-json.js';

/**
 * The quorum service lists every masternode of a network with its PoSe status
 * and the result of its DAPI version check. It answers CORS requests from any
 * origin (`access-control-allow-origin: *`, including preflights), so browsers
 * can read it directly. Discovery uses it as a health hint and as the fallback
 * when the masternode list can't be read (see evonode-discovery.ts).
 */
export function quorumMasternodesUrl(network: 'testnet' | 'mainnet'): string {
  return `https://quorums.${network}.networks.dash.org/masternodes`;
}

const EVONODE_FETCH_TIMEOUT_MS = 5000;

/** Port of the evonode DAPI endpoint (gRPC-web over HTTPS). */
const DAPI_HTTPS_PORT = 1443;

// Plain IPv4 / DNS hostnames only: the result is turned into a URL and handed
// to dapi-client, so anything exotic (IPv6 literals, userinfo, paths) is dropped.
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * `https://<host>:<port>` when `host` and `port` make a usable DAPI endpoint,
 * otherwise undefined.
 */
export function toDapiEndpoint(host: unknown, port: unknown = DAPI_HTTPS_PORT): string | undefined {
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) return undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const endpoint = `https://${host}:${port}`;
  // The regex alone admits non-URLs such as 999.1.1.1, and one of those
  // would make the DAPI client constructor throw for the whole list.
  try {
    new URL(endpoint);
  } catch {
    return undefined;
  }
  return endpoint;
}

/**
 * Extract DAPI endpoints (`https://<host>:1443`) of healthy evonodes from the
 * quorum service payload. Healthy means PoSe status ENABLED and a successful
 * DAPI version check. Order is preserved; duplicates are dropped.
 */
export function parseEvonodeAddresses(payload: unknown): string[] {
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return [];

  const endpoints = new Set<string>();
  for (const node of data) {
    if (!node || typeof node !== 'object') continue;
    const { address, addresses, status, versionCheck } = node as Record<string, unknown>;
    if (status !== 'ENABLED' || versionCheck !== 'success') continue;
    const endpoint = platformEndpoint(addresses) ?? coreHostEndpoint(address);
    if (endpoint) endpoints.add(endpoint);
  }
  return [...endpoints];
}

/** The node's DAPI endpoint from `addresses.platform_https` ("host:port"), as the masternode list has it. */
function platformEndpoint(addresses: unknown): string | undefined {
  const https = (addresses as { platform_https?: unknown } | null | undefined)?.platform_https;
  const first = Array.isArray(https) ? https[0] : undefined;
  if (typeof first !== 'string') return undefined;
  const separator = first.lastIndexOf(':');
  if (separator <= 0) return undefined;
  return toDapiEndpoint(first.slice(0, separator), Number(first.slice(separator + 1)));
}

/** Older records: `address` is the Core P2P endpoint (host:19999); only its host is reused, on port 1443. */
function coreHostEndpoint(address: unknown): string | undefined {
  return typeof address === 'string' ? toDapiEndpoint(address.replace(/:\d+$/, '')) : undefined;
}

/**
 * Healthy evonode endpoints from the network's quorum service (one attempt,
 * 5 s). Resolves an empty list, after logging why, when the service fails.
 */
export async function fetchHealthyEvonodeAddresses(network: 'testnet' | 'mainnet'): Promise<string[]> {
  try {
    return parseEvonodeAddresses(
      await fetchJson(quorumMasternodesUrl(network), {}, EVONODE_FETCH_TIMEOUT_MS)
    );
  } catch (error) {
    console.warn(`Could not fetch the ${network} evonode list from the quorum service:`, error);
    return [];
  }
}

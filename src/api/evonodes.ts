import type { NetworkConfig } from '../config.js';
import { fetchJson } from '../utils/fetch-json.js';

/**
 * Quorum service lists every testnet masternode with its PoSe status and the
 * result of its DAPI version check. It answers CORS requests from any origin
 * (`access-control-allow-origin: *`, including preflights), so browsers can
 * read it directly.
 */
export const TESTNET_MASTERNODES_URL = 'https://quorums.testnet.networks.dash.org/masternodes';

export const EVONODE_FETCH_TIMEOUT_MS = 5000;

/** Below this many live nodes the fetched list is not trusted on its own. */
export const MIN_DYNAMIC_EVONODES = 3;

const DAPI_HTTPS_PORT = 1443;

// Plain IPv4 / DNS hostnames only: the result is turned into a URL and handed
// to dapi-client, so anything exotic (IPv6 literals, userinfo, paths) is dropped.
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

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
    const { address, status, versionCheck } = node as Record<string, unknown>;
    if (status !== 'ENABLED' || versionCheck !== 'success' || typeof address !== 'string') continue;
    // `address` is the Core P2P endpoint (host:19999); only the host is reused.
    const host = address.replace(/:\d+$/, '');
    if (!HOST_PATTERN.test(host)) continue;
    endpoints.add(`https://${host}:${DAPI_HTTPS_PORT}`);
  }
  return [...endpoints];
}

/**
 * Testnet DAPI endpoints for this session. Fetches the live evonode list
 * (one attempt, 5 s) because certificates rotate every few days and nodes come
 * and go, which makes a static list go stale. Falls back to `staticAddresses`
 * when the fetch fails and tops the live list up with them when it yields
 * fewer than {@link MIN_DYNAMIC_EVONODES} nodes.
 */
export async function resolveTestnetDapiAddresses(
  staticAddresses: readonly string[],
  timeoutMs: number = EVONODE_FETCH_TIMEOUT_MS
): Promise<string[]> {
  let live: string[] = [];
  try {
    live = parseEvonodeAddresses(await fetchJson(TESTNET_MASTERNODES_URL, {}, timeoutMs));
  } catch (error) {
    console.warn('Could not fetch the testnet evonode list; using the built-in list:', error);
  }

  if (live.length >= MIN_DYNAMIC_EVONODES) return live;
  if (live.length > 0) {
    console.warn(`Only ${live.length} live testnet evonodes found; adding the built-in list`);
  }
  return [...new Set([...live, ...staticAddresses])];
}

/**
 * DAPI endpoints to dial for a network: testnet resolves the live evonode
 * list (see {@link resolveTestnetDapiAddresses}); mainnet and devnets use
 * their configured addresses unchanged and make no request.
 */
export async function resolveDapiAddresses(
  config: Pick<NetworkConfig, 'type' | 'dapiAddresses'>
): Promise<string[] | undefined> {
  if (config.type === 'testnet' && config.dapiAddresses) {
    return resolveTestnetDapiAddresses(config.dapiAddresses);
  }
  return config.dapiAddresses;
}

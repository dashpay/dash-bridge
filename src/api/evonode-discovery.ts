/* eslint-disable @typescript-eslint/no-explicit-any */

import dashcoreLib from '@dashevo/dashcore-lib';
import cbor from 'cbor';
import { fetchTestnetEvonodeAddresses, toDapiEndpoint } from './evonodes.js';

/** A DAPI endpoint in the shape dapi-client's `dapiAddresses` option takes. */
export interface DapiAddress {
  protocol: string;
  host: string;
  port: number;
}

/** A dapi-client pinned to the given addresses. */
export type CreateDapiClient = (addresses: DapiAddress[]) => any;

/** Longest one masternode list fetch may take, across all seeds tried. */
export const MASTERNODE_LIST_TIMEOUT_MS = 10000;
/** A seed that hasn't answered by then gets company: the next seed is asked too. */
export const SEED_HEDGE_DELAY_MS = 3000;
/** A list older than this is fetched again before use. */
export const EVONODE_LIST_MAX_AGE_MS = 10 * 60_000;
/**
 * Fewest evonodes that both the masternode list and the quorum service's
 * health check vouch for before discovery narrows to them (one per IS lock
 * stream).
 */
export const MIN_HEALTHY_EVONODES = 3;

const { SimplifiedMNList, SimplifiedMNListDiff } = dashcoreLib as any;

/** dapi-client seed entries (`host:port`) as addresses; DAPI is served over HTTPS. */
export function seedAddresses(seeds: readonly string[]): DapiAddress[] {
  return seeds.map((seed) => parseDapiAddress(`https://${seed}`));
}

/** Parse a `https://host:port` URL into a dapi-client address. */
export function parseDapiAddress(url: string): DapiAddress {
  const parsed = new URL(url);
  return {
    protocol: parsed.protocol.replace(':', ''),
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 443,
  };
}

/** Distinct DAPI endpoints of the valid evonodes in a simplified masternode list. */
export function evonodeEndpointsFromSml(sml: any): string[] {
  const endpoints = new Set<string>();
  for (const entry of sml.getValidMasternodesList()) {
    // null for regular masternodes; handles evonodes registered with
    // extended addresses, whose DAPI host can differ from the Core P2P host.
    const platform = entry.getPlatformHTTPSEndpoint();
    const endpoint = platform && toDapiEndpoint(platform.host, platform.port);
    if (endpoint) endpoints.add(endpoint);
  }
  return [...endpoints];
}

function disconnectQuietly(client: any): void {
  Promise.resolve().then(() => client?.disconnect()).catch(() => {});
}

function cancelQuietly(stream: any): void {
  try { stream?.cancel(); } catch { /* ignore */ }
}

/**
 * Read the simplified masternode list once from the network seeds and return
 * its evonode endpoints. Opens `subscribeToMasternodeList` on one seed (its
 * first message is the full list), adds the next seed when a seed fails or
 * hasn't answered within {@link SEED_HEDGE_DELAY_MS}, takes the first list
 * and cancels every stream. Rejects when all seeds fail, at
 * {@link MASTERNODE_LIST_TIMEOUT_MS}, or when `signal` aborts.
 *
 * One-shot on purpose: dapi-client's own long-lived list stream never
 * resyncs after an error, and in browsers it then keeps reconnecting with
 * nobody listening.
 */
export function fetchEvonodesFromSeeds(
  seeds: readonly DapiAddress[],
  createClient: CreateDapiClient,
  network: string,
  signal?: AbortSignal
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    // Attempts still in play; leaving this set is what retires an attempt.
    const open = new Set<{ client?: any; stream?: any }>();
    let next = 0;
    let failures = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const release = (attempt: { client?: any; stream?: any }): void => {
      cancelQuietly(attempt.stream);
      disconnectQuietly(attempt.client);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(hedgeTimer);
      signal?.removeEventListener('abort', onAbort);
      for (const attempt of open) release(attempt);
      open.clear();
      fn();
    };
    const onAbort = (): void => finish(() => reject(new Error('Masternode list fetch aborted')));
    const deadlineTimer = setTimeout(
      () => finish(() => reject(new Error(`Masternode list fetch timed out after ${MASTERNODE_LIST_TIMEOUT_MS}ms`))),
      MASTERNODE_LIST_TIMEOUT_MS
    );

    const tryNextSeed = (): void => {
      clearTimeout(hedgeTimer);
      const seed = seeds[next++];
      if (!seed) return;
      hedgeTimer = setTimeout(tryNextSeed, SEED_HEDGE_DELAY_MS);
      const attempt: { client?: any; stream?: any } = {};
      open.add(attempt);

      const fail = (error: unknown): void => {
        if (!open.delete(attempt)) return;
        release(attempt);
        console.warn(`[evonode-discovery] seed ${seed.host}:${seed.port} failed:`, error);
        failures += 1;
        if (failures >= seeds.length) {
          const reason = error instanceof Error ? error.message : String(error);
          finish(() => reject(new Error(`Masternode list unavailable: ${failures} seeds tried, last error: ${reason}`)));
        } else {
          tryNextSeed();
        }
      };

      try {
        attempt.client = createClient([seed]);
        Promise.resolve(attempt.client.core.subscribeToMasternodeList({ retries: 0 }))
          .then((stream: any) => {
            if (!open.has(attempt)) {
              // Settled or failed while the stream was being opened.
              cancelQuietly(stream);
              return;
            }
            attempt.stream = stream;
            stream.on('data', (response: any) => {
              if (!open.has(attempt)) return;
              let endpoints: string[];
              try {
                const bytes = Buffer.from(response.getMasternodeListDiff_asU8());
                const diff = new SimplifiedMNListDiff(cbor.decodeFirstSync(bytes), network);
                endpoints = evonodeEndpointsFromSml(new SimplifiedMNList(diff));
              } catch (error) {
                fail(error);
                return;
              }
              console.log(`[evonode-discovery] ${endpoints.length} evonodes from seed ${seed.host}:${seed.port}`);
              finish(() => resolve(endpoints));
            });
            // In browsers a failed stream reports through 'end' (with a status)
            // as well as 'error'; only the first report counts.
            stream.on('error', (error: unknown) => fail(error));
            stream.on('end', () => fail(new Error('Masternode list stream ended before sending the list')));
          })
          .catch(fail);
      } catch (error) {
        fail(error);
      }
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (seeds.length === 0) {
      finish(() => reject(new Error('No masternode list seeds configured')));
      return;
    }
    tryNextSeed();
  });
}

export interface EvonodeDiscoveryOptions {
  network: string;
  seeds: readonly DapiAddress[];
  createClient: CreateDapiClient;
  /** Quorum-service list of evonodes that pass its health check. */
  fetchHealthy?: () => Promise<string[]>;
  now?: () => number;
}

/**
 * Finds the testnet evonodes to open IS lock streams on. The source is the
 * simplified masternode list served by the network seeds (dapi-client's
 * discovery source), read with {@link fetchEvonodesFromSeeds}. The quorum
 * service's list of nodes passing its DAPI health check is read alongside:
 * when at least {@link MIN_HEALTHY_EVONODES} nodes are in both, only those
 * are used; when the masternode list can't be read, the quorum service list
 * is used on its own.
 *
 * Every valid evonode in the list is considered, not dapi-client's testnet
 * address provider result, which also filters by a snapshot of addresses
 * bundled with the library.
 *
 * The result is kept for {@link EVONODE_LIST_MAX_AGE_MS}, then read again.
 * If that read finds nothing, the previous list is used rather than none.
 * getNodes() rejects only when no list was ever found, so the caller stops
 * before broadcasting.
 */
export class EvonodeDiscovery {
  private readonly network: string;
  private readonly seeds: readonly DapiAddress[];
  private readonly createClient: CreateDapiClient;
  private readonly fetchHealthy: () => Promise<string[]>;
  private readonly now: () => number;
  private list?: { endpoints: string[]; fetchedAt: number };
  // In-flight read, shared by concurrent callers (warm() and getNodes()).
  private pending?: { promise: Promise<string[]>; controller: AbortController };
  private shared?: { key: string; client: any };

  constructor(options: EvonodeDiscoveryOptions) {
    this.network = options.network;
    this.seeds = options.seeds;
    this.createClient = options.createClient;
    this.fetchHealthy = options.fetchHealthy ?? fetchTestnetEvonodeAddresses;
    this.now = options.now ?? Date.now;
  }

  /**
   * A client over the most recently discovered evonodes, for calls that may
   * go to any of them (e.g. getTransaction); undefined before the first
   * discovery.
   */
  get sharedClient(): any {
    return this.shared?.client;
  }

  /**
   * The current evonode endpoints. Rejects when none can be found, or when
   * `signal` aborts.
   */
  async getNodes(signal?: AbortSignal): Promise<DapiAddress[]> {
    const endpoints = await whenNotAborted(this.readList(), signal);
    if (endpoints.length === 0) {
      throw new Error('No testnet evonodes found: the masternode list and the quorum service both failed');
    }
    const nodes = endpoints.map(parseDapiAddress);
    this.updateSharedClient(endpoints, nodes);
    return nodes;
  }

  /**
   * Find the evonodes ahead of the first getNodes(). Settles (never rejects)
   * once the read finishes either way.
   */
  async warm(): Promise<void> {
    await this.readList();
  }

  async disconnect(): Promise<void> {
    this.pending?.controller.abort();
    const shared = this.shared;
    this.shared = undefined;
    if (shared) disconnectQuietly(shared.client);
  }

  /** Endpoints of a fresh enough list, read again when stale; [] when none was ever found. */
  private readList(): Promise<string[]> {
    if (this.list && this.now() - this.list.fetchedAt < EVONODE_LIST_MAX_AGE_MS) {
      return Promise.resolve(this.list.endpoints);
    }
    if (!this.pending) {
      const controller = new AbortController();
      const pending = {
        controller,
        promise: this.discover(controller.signal).finally(() => {
          // A read aborted by disconnect() may finish after a newer one started.
          if (this.pending === pending) this.pending = undefined;
        }),
      };
      this.pending = pending;
    }
    return this.pending.promise;
  }

  private async discover(signal: AbortSignal): Promise<string[]> {
    const [fromList, healthy] = await Promise.all([
      fetchEvonodesFromSeeds(shuffled(this.seeds), this.createClient, this.network, signal).catch((error) => {
        console.warn('[evonode-discovery] masternode list unavailable:', error);
        return [] as string[];
      }),
      this.fetchHealthy().catch(() => [] as string[]),
    ]);

    let endpoints = fromList;
    if (fromList.length > 0) {
      const healthySet = new Set(healthy);
      const vouched = fromList.filter((endpoint) => healthySet.has(endpoint));
      if (vouched.length >= MIN_HEALTHY_EVONODES) endpoints = vouched;
    } else if (healthy.length > 0) {
      console.warn(`[evonode-discovery] using ${healthy.length} evonodes from the quorum service`);
      endpoints = healthy;
    }

    if (endpoints.length > 0) {
      this.list = { endpoints, fetchedAt: this.now() };
      return endpoints;
    }
    if (this.list) {
      console.warn('[evonode-discovery] no evonodes found; keeping the previous list');
      return this.list.endpoints;
    }
    return [];
  }

  private updateSharedClient(endpoints: string[], nodes: DapiAddress[]): void {
    const key = endpoints.join(',');
    if (this.shared?.key === key) return;
    const previous = this.shared;
    this.shared = { key, client: this.createClient(nodes) };
    if (previous) disconnectQuietly(previous.client);
  }
}

function whenNotAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('Evonode discovery aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

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

/** Longest one masternode list fetch may take, across all seeds tried. */
export const MASTERNODE_LIST_TIMEOUT_MS = 10000;
/** A seed that hasn't answered by then gets company: the next seed is asked too. */
export const SEED_HEDGE_DELAY_MS = 3000;
/** A list older than this is fetched again before use. */
export const EVONODE_LIST_MAX_AGE_MS = 10 * 60_000;

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
  const entries: any[] = sml?.getValidMasternodesList?.() ?? [];
  const endpoints = new Set<string>();
  for (const entry of entries) {
    // null for regular masternodes; handles evonodes registered with
    // extended addresses, whose DAPI host can differ from the Core P2P host.
    const platform = entry?.getPlatformHTTPSEndpoint?.();
    const endpoint = platform && toDapiEndpoint(platform.host, platform.port);
    if (endpoint) endpoints.add(endpoint);
  }
  return [...endpoints];
}

/** Evonode endpoints in a masternode list stream message (a full diff from the genesis block). */
export function evonodeEndpointsFromListMessage(response: any, network: string): string[] {
  const bytes = Buffer.from(response.getMasternodeListDiff_asU8());
  const diff = new SimplifiedMNListDiff(cbor.decodeFirstSync(bytes), network);
  return evonodeEndpointsFromSml(new SimplifiedMNList(diff));
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
  createClient: (seed: DapiAddress) => any,
  network: string,
  signal?: AbortSignal
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const open = new Set<{ client: any; stream?: any }>();
    let next = 0;
    let failures = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(hedgeTimer);
      signal?.removeEventListener('abort', onAbort);
      for (const attempt of open) {
        try { attempt.stream?.cancel(); } catch { /* ignore */ }
        Promise.resolve().then(() => attempt.client.disconnect()).catch(() => {});
      }
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
      const attempt: { client: any; stream?: any } = { client: undefined };
      let failed = false;
      const fail = (error: unknown): void => {
        if (settled || failed) return;
        failed = true;
        open.delete(attempt);
        try { attempt.stream?.cancel(); } catch { /* ignore */ }
        Promise.resolve().then(() => attempt.client?.disconnect()).catch(() => {});
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
        attempt.client = createClient(seed);
        open.add(attempt);
        Promise.resolve(attempt.client.core.subscribeToMasternodeList({ retries: 0 })).then((stream: any) => {
          if (settled || failed) {
            try { stream.cancel(); } catch { /* ignore */ }
            return;
          }
          attempt.stream = stream;
          stream.on('data', (response: unknown) => {
            if (settled || failed) return;
            let endpoints: string[];
            try {
              endpoints = evonodeEndpointsFromListMessage(response, network);
            } catch (error) {
              fail(error);
              return;
            }
            console.log(`[evonode-discovery] ${endpoints.length} evonodes from seed ${seed.host}:${seed.port}`);
            finish(() => resolve(endpoints));
          });
          // In browsers a failed stream reports through 'end' (with a status)
          // as well as 'error'; `failed` makes the second report a no-op.
          stream.on('error', (error: unknown) => fail(error));
          stream.on('end', () => fail(new Error('Masternode list stream ended before sending the list')));
        }, fail);
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
  /** A dapi-client pinned to the given addresses. */
  createClient: (addresses: DapiAddress[]) => any;
  /** Quorum-service list, used when the masternode list can't be read. */
  fetchFallback?: () => Promise<string[]>;
  now?: () => number;
}

/**
 * Finds the testnet evonodes to open IS lock streams on, from the simplified
 * masternode list served by the network seeds (dapi-client's discovery
 * source), read with {@link fetchEvonodesFromSeeds}. The list is kept for
 * {@link EVONODE_LIST_MAX_AGE_MS} and fetched again after that, so a long
 * session never works from a stale list.
 *
 * Every valid evonode in the list is used, not dapi-client's testnet address
 * provider result, which also filters by a snapshot of addresses bundled with
 * the library. Bad nodes cost little: the subscription races several and
 * replaces failed ones.
 *
 * When the masternode list can't be read, the quorum service list is used
 * instead. When both fail, getNodes() rejects, so the caller stops before
 * broadcasting.
 */
export class EvonodeDiscovery {
  private readonly network: string;
  private readonly seeds: readonly DapiAddress[];
  private readonly createClient: (addresses: DapiAddress[]) => any;
  private readonly fetchFallback: () => Promise<string[]>;
  private readonly now: () => number;
  private list?: { endpoints: string[]; fetchedAt: number };
  // In-flight masternode list read, shared by concurrent callers (warm() and
  // getNodes()). Each read has its own deadline and closes its own streams.
  private pendingFetch?: Promise<string[]>;
  // Aborts the in-flight read on disconnect().
  private fetchController?: AbortController;
  private shared?: { key: string; client: any };

  constructor(options: EvonodeDiscoveryOptions) {
    this.network = options.network;
    this.seeds = options.seeds;
    this.createClient = options.createClient;
    this.fetchFallback = options.fetchFallback ?? fetchTestnetEvonodeAddresses;
    this.now = options.now ?? Date.now;
  }

  /**
   * A client over the most recently discovered evonodes, for calls that may
   * go to any of them (e.g. getTransaction); undefined before the first
   * discovery.
   */
  get sharedClient(): any | undefined {
    return this.shared?.client;
  }

  /**
   * The current evonode endpoints. Rejects when neither the masternode list
   * nor the quorum service yields one, or when `signal` aborts.
   */
  async getNodes(signal?: AbortSignal): Promise<DapiAddress[]> {
    let endpoints = await this.whenNotAborted(this.readList(), signal);
    if (endpoints.length === 0) {
      endpoints = await this.whenNotAborted(this.fetchFallback(), signal);
      if (endpoints.length > 0) {
        console.warn(`[evonode-discovery] using ${endpoints.length} evonodes from the quorum service`);
      }
    }
    if (endpoints.length === 0) {
      throw new Error('No testnet evonodes found: the masternode list and the quorum service both failed');
    }
    const nodes = endpoints.map(parseDapiAddress);
    this.updateSharedClient(endpoints, nodes);
    return nodes;
  }

  /**
   * Read the masternode list ahead of the first getNodes(). Settles (never
   * rejects) once the list is read or the read fails.
   */
  async warm(): Promise<void> {
    await this.readList();
  }

  async disconnect(): Promise<void> {
    this.fetchController?.abort();
    const shared = this.shared;
    this.shared = undefined;
    if (shared) {
      try { await shared.client.disconnect(); } catch { /* ignore */ }
    }
  }

  /** Endpoints from a fresh enough masternode list, or [] when it can't be read. */
  private readList(): Promise<string[]> {
    if (this.list && this.now() - this.list.fetchedAt < EVONODE_LIST_MAX_AGE_MS) {
      return Promise.resolve(this.list.endpoints);
    }
    if (!this.pendingFetch) {
      const controller = new AbortController();
      this.fetchController = controller;
      const fetch = fetchEvonodesFromSeeds(
        shuffled(this.seeds),
        (seed) => this.createClient([seed]),
        this.network,
        controller.signal
      ).then(
        (endpoints) => {
          if (endpoints.length > 0) this.list = { endpoints, fetchedAt: this.now() };
          else console.warn('[evonode-discovery] masternode list has no valid evonodes');
          return endpoints;
        },
        (error) => {
          console.warn('[evonode-discovery] masternode list unavailable:', error);
          return [] as string[];
        }
      ).finally(() => {
        if (this.pendingFetch === fetch) this.pendingFetch = undefined;
      });
      this.pendingFetch = fetch;
    }
    return this.pendingFetch;
  }

  private updateSharedClient(endpoints: string[], nodes: DapiAddress[]): void {
    const key = endpoints.join(',');
    if (this.shared?.key === key) return;
    const previous = this.shared;
    this.shared = { key, client: this.createClient(nodes) };
    if (previous) Promise.resolve().then(() => previous.client.disconnect()).catch(() => {});
  }

  private whenNotAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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
}

export function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

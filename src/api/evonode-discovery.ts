/* eslint-disable @typescript-eslint/no-explicit-any */

import { fetchTestnetEvonodeAddresses, toDapiEndpoint } from './evonodes.js';

/** A DAPI endpoint in the shape dapi-client's `dapiAddresses` option takes. */
export interface DapiAddress {
  protocol: string;
  host: string;
  port: number;
}

/** Longest a masternode list sync may take before the quorum service is asked instead. */
export const DISCOVERY_TIMEOUT_MS = 10000;

/** SimplifiedMNListEntry.nType of evonodes (HP masternodes), the only ones serving DAPI. */
const EVONODE_TYPE = 1;

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
    if (entry?.nType !== EVONODE_TYPE) continue;
    const endpoint = toDapiEndpoint(entry.getIp?.(), Number(entry.platformHTTPPort));
    if (endpoint) endpoints.add(endpoint);
  }
  return [...endpoints];
}

class DeadlineError extends Error {}

function rejectAfter(ms: number, message: string): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(message)), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

function rejectOnAbort(signal: AbortSignal | undefined, message: string): { promise: Promise<never>; clear: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(new Error(message));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, clear: () => { if (onAbort) signal?.removeEventListener('abort', onAbort); } };
}

/**
 * Finds the testnet evonodes to open IS lock streams on, using dapi-client's
 * own masternode-list discovery: the client syncs the simplified masternode
 * list from the network seeds and keeps it current over a stream, so every
 * call sees the list as of the latest block.
 *
 * The valid evonodes are read from the list directly instead of through the
 * client's address provider, which on testnet also filters them by a snapshot
 * of addresses bundled with the library. Bad nodes in the list cost little:
 * the subscription races several and replaces failed ones.
 *
 * When the masternode list can't be synced in time, the quorum service list
 * is used instead. When both fail, getNodes() rejects, so the caller stops
 * before broadcasting.
 */
export class EvonodeDiscovery {
  private client: any;
  // The current client's in-flight list read, shared by concurrent callers so
  // they don't open a second masternode list stream.
  private pendingRead?: Promise<string[]>;
  // Set when a read missed its deadline: the next read starts over on a new
  // client instead of waiting on a sync that may never finish.
  private replaceClient = false;

  constructor(
    private readonly createClient: () => any,
    private readonly fetchFallback: () => Promise<string[]> = fetchTestnetEvonodeAddresses,
    private readonly timeoutMs: number = DISCOVERY_TIMEOUT_MS
  ) {
    this.client = createClient();
  }

  /** The discovery client, for calls that may go to any node (e.g. getTransaction). */
  get sharedClient(): any {
    return this.client;
  }

  /**
   * The current evonode endpoints. Rejects when neither the masternode list
   * nor the quorum service yields one, or when `signal` aborts.
   */
  async getNodes(signal?: AbortSignal): Promise<DapiAddress[]> {
    const abortMessage = 'Evonode discovery aborted';
    const abort = rejectOnAbort(signal, abortMessage);
    try {
      let endpoints = await Promise.race([this.readListWithDeadline(), abort.promise]);
      if (endpoints.length === 0) {
        endpoints = await Promise.race([this.fetchFallback(), abort.promise]);
        if (endpoints.length > 0) {
          console.warn(`[evonode-discovery] using ${endpoints.length} evonodes from the quorum service`);
        }
      }
      if (endpoints.length === 0) {
        throw new Error('No testnet evonodes found: the masternode list and the quorum service both failed');
      }
      return endpoints.map(parseDapiAddress);
    } finally {
      abort.clear();
    }
  }

  /**
   * Start syncing the masternode list ahead of the first getNodes(). Settles
   * (never rejects) once the list is read, the sync fails, or the deadline
   * passes; the sync keeps going after the deadline.
   */
  async warm(): Promise<void> {
    await this.readListWithDeadline();
  }

  async disconnect(): Promise<void> {
    this.pendingRead = undefined;
    try { await this.client.disconnect(); } catch { /* ignore */ }
  }

  /** Endpoints from the masternode list, or [] when it fails or misses the deadline. */
  private async readListWithDeadline(): Promise<string[]> {
    const deadline = rejectAfter(this.timeoutMs, `masternode list sync timed out after ${this.timeoutMs}ms`);
    try {
      const endpoints = await Promise.race([this.readList(), deadline.promise]);
      if (endpoints.length === 0) console.warn('[evonode-discovery] masternode list has no valid evonodes');
      return endpoints;
    } catch (error) {
      if (error instanceof DeadlineError) this.replaceClient = true;
      console.warn('[evonode-discovery] masternode list unavailable:', error);
      return [];
    } finally {
      deadline.clear();
    }
  }

  private readList(): Promise<string[]> {
    // dapi-client sets the list stream to null once it errors or ends, and
    // from then on returns the last list without ever resyncing. Replace the
    // client then (or after a missed deadline), so a dropped or stuck stream
    // (a network change, an iOS download prompt) can't leave a stale list.
    if (this.replaceClient || this.client.dapiAddressProvider?.smlProvider?.stream === null) {
      this.replaceClient = false;
      const stale = this.client;
      this.client = this.createClient();
      this.pendingRead = undefined;
      Promise.resolve().then(() => stale.disconnect()).catch(() => {});
    }
    const provider = this.client.dapiAddressProvider?.smlProvider;
    if (!provider) return Promise.reject(new Error('dapi-client has no masternode list provider'));

    if (!this.pendingRead) {
      const read = Promise.resolve(provider.getSimplifiedMNList()).then(evonodeEndpointsFromSml);
      const clear = (): void => {
        if (this.pendingRead === read) this.pendingRead = undefined;
      };
      read.then(clear, clear);
      this.pendingRead = read;
    }
    return this.pendingRead;
  }
}

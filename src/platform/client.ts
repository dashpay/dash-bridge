import { EvoSDK } from '@dashevo/evo-sdk';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import { getNetwork } from '../config.js';

export type PlatformNetwork = string;

export interface PlatformIdentityKeyRecord {
  keyId: number;
  keyType?: string;
  purpose?: string;
  securityLevel?: string;
  data?: unknown;
  disabledAt?: unknown;
}

const PLATFORM_REQUEST_SETTINGS = {
  connectTimeoutMs: 10000,
  // wait_for_state_transition_result uses a 30s server-side wait window,
  // so client-side request timeout must exceed that on runtimes that honor it.
  timeoutMs: 40000,
  retries: 2,
  banFailedAddress: true,
} as const;

export const PLATFORM_PUT_SETTINGS = {
  ...PLATFORM_REQUEST_SETTINGS,
} as const;

const PLATFORM_OPERATION_TIMEOUT_MS = 45000;

const sdkCache = new Map<string, EvoSDK>();

function createPlatformSdk(network: PlatformNetwork): EvoSDK {
  const options = { settings: PLATFORM_REQUEST_SETTINGS };
  const config = getNetwork(network);

  if (config.type === 'mainnet') {
    return EvoSDK.mainnetTrusted(options);
  }

  if (config.type === 'devnet') {
    if (!config.dapiAddresses?.length) {
      throw new Error(
        `Devnet "${config.name}" is missing dapiAddresses; cannot create Platform SDK`
      );
    }
    // EXPLICITLY trusted: false on devnets.
    //
    // trusted: true makes the WASM SDK attach the testnet "trusted context"
    // (quorum keys, chain checkpoints) which it then uses to verify proofs.
    // That context's address list overrides our custom devnet addresses, so
    // queries get routed to the public testnet DAPI nodes instead of the
    // devnet masternodes — at best returning wrong data, at worst silently
    // succeeding against testnet while looking like it works against devnet.
    // We verified this empirically against paloma: any apparent success in
    // trusted mode is a coincidence of state, not a real query.
    //
    // For the chainlock fallback we read core_chain_locked_height via
    // @dashevo/dapi-client.platform.getStatus() directly against the
    // devnet's dapiAddresses — see
    // DAPISubscriptionClient.getCoreChainLockedHeight in api/dapi-subscription.ts.
    return new EvoSDK({
      addresses: config.dapiAddresses,
      network: 'testnet',
      trusted: false,
      ...options,
    });
  }

  return EvoSDK.testnetTrusted(options);
}

export async function connectPlatformSdk(
  network: PlatformNetwork,
  retryOptions?: RetryOptions
): Promise<EvoSDK> {
  const cached = sdkCache.get(network);
  if (cached && cached.isConnected) {
    return cached;
  }

  const sdk = createPlatformSdk(network);

  console.log(`Connecting to ${network}...`);
  await withRetry(() => sdk.connect(), retryOptions);
  console.log('Connected to Platform');

  sdkCache.set(network, sdk);
  return sdk;
}

export function disconnectPlatformSdk(network: PlatformNetwork): void {
  sdkCache.delete(network);
}

function isConnectionError(error: unknown): boolean {
  if (!(error && typeof error === 'object' && 'message' in error)) {
    return false;
  }
  const msg = String((error as { message: unknown }).message).toLowerCase();
  return (
    msg.includes('transport') ||
    msg.includes('connection') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('unavailable') ||
    msg.includes('failed to fetch')
  );
}

export async function withConnectedPlatformSdk<T>(
  network: PlatformNetwork,
  callback: (sdk: EvoSDK) => Promise<T>,
  retryOptions?: RetryOptions
): Promise<T> {
  const sdk = await connectPlatformSdk(network, retryOptions);
  try {
    return await callback(sdk);
  } catch (error) {
    if (isConnectionError(error)) {
      disconnectPlatformSdk(network);
    }
    throw error;
  }
}

export async function withPlatformOperationTimeout<T>(
  promise: Promise<T>,
  action: string,
  timeoutMs: number = PLATFORM_OPERATION_TIMEOUT_MS
): Promise<T> {
  let timeoutId: number | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`Timed out while ${action}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

export async function fetchIdentityWithSdk(
  sdk: EvoSDK,
  identityId: string,
  retryOptions?: RetryOptions
) {
  return withRetry(() => sdk.identities.fetch(identityId), retryOptions);
}

export async function fetchIdentity(
  identityId: string,
  network: PlatformNetwork,
  retryOptions?: RetryOptions
) {
  return withConnectedPlatformSdk(
    network,
    (sdk) => fetchIdentityWithSdk(sdk, identityId, retryOptions),
    retryOptions
  );
}

export async function getIdentityBalanceAndRevisionWithSdk(
  sdk: EvoSDK,
  identityId: string,
  retryOptions?: RetryOptions
): Promise<{ balance: number; revision: number }> {
  const result = await withRetry(
    () => sdk.identities.balanceAndRevision(identityId),
    retryOptions
  );

  return {
    balance: Number(result?.balance ?? 0n),
    revision: Number(result?.revision ?? 0n),
  };
}

export async function getIdentityBalanceAndRevision(
  identityId: string,
  network: PlatformNetwork,
  retryOptions?: RetryOptions
): Promise<{ balance: number; revision: number }> {
  return withConnectedPlatformSdk(
    network,
    (sdk) => getIdentityBalanceAndRevisionWithSdk(sdk, identityId, retryOptions),
    retryOptions
  );
}

export async function fetchIdentityPublicKeyRecordsWithSdk(
  sdk: EvoSDK,
  identityId: string,
  retryOptions?: RetryOptions
): Promise<PlatformIdentityKeyRecord[]> {
  const keysResponse = await withRetry(
    () => sdk.identities.getKeys({
      identityId,
      request: { type: 'all' },
    }),
    retryOptions
  );

  if (!keysResponse) {
    throw new Error('Identity not found');
  }

  const keysArray = Array.isArray(keysResponse) ? keysResponse : [keysResponse];
  if (keysArray.length === 0) {
    throw new Error('Identity has no keys');
  }

  return keysArray as PlatformIdentityKeyRecord[];
}

export async function fetchIdentityPublicKeyRecords(
  identityId: string,
  network: PlatformNetwork,
  retryOptions?: RetryOptions
): Promise<PlatformIdentityKeyRecord[]> {
  return withConnectedPlatformSdk(
    network,
    (sdk) => fetchIdentityPublicKeyRecordsWithSdk(sdk, identityId, retryOptions),
    retryOptions
  );
}

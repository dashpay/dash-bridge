export interface NetworkConfig {
  type: 'testnet' | 'mainnet' | 'devnet';
  name: string;
  addressPrefix: number;
  /** Base58 version byte for P2SH addresses (dashcore SCRIPT_ADDRESS: 16 mainnet, 19 testnet/devnet). */
  p2shPrefix: number;
  wifPrefix: number;
  minFee: number;
  dustThreshold: number;
  platformHrp: string;
  faucetBaseUrl?: string;
  dapiAddresses?: string[];
  /**
   * Devnet-only: opt in to the SDK's trusted-context mode. When true, the
   * SDK prefetches a quorum context (from `trustedQuorumUrl` if set,
   * otherwise from `https://quorums.<devnetName>.networks.dash.org`) so it
   * can verify proofs and discover masternode addresses — same proof-bearing
   * read/write surface as mainnet/testnet trusted.
   */
  useTrustedContext?: boolean;
  /** Devnet-only: explicit quorum context URL (overrides DNS-derived URL). */
  trustedQuorumUrl?: string;
}

/**
 * Bare devnet name expected by the SDK's `EvoSDK.devnet` / `EvoSDK.devnetTrusted`
 * factories. Our config names are conventionally `devnet-<name>`; the SDK
 * derives the default trusted-quorum URL from the bare name.
 */
export function devnetNameForSdk(name: string): string {
  return name.startsWith('devnet-') ? name.slice('devnet-'.length) : name;
}

export const TESTNET: NetworkConfig = {
  type: 'testnet',
  name: 'testnet',
  addressPrefix: 140,
  p2shPrefix: 19,
  wifPrefix: 239,
  minFee: 1000,
  dustThreshold: 546,
  platformHrp: 'tdash',
  faucetBaseUrl: 'https://faucet.thepasta.org',
};

export const MAINNET: NetworkConfig = {
  type: 'mainnet',
  name: 'mainnet',
  addressPrefix: 76,
  p2shPrefix: 16,
  wifPrefix: 204,
  minFee: 1000,
  dustThreshold: 546,
  platformHrp: 'dash',
};

export const DEVNET_MOUTAI: NetworkConfig = {
  type: 'devnet',
  name: 'devnet-moutai',
  addressPrefix: 140,
  p2shPrefix: 19,
  wifPrefix: 239,
  minFee: 1000,
  dustThreshold: 546,
  platformHrp: 'tdash',
  // All 13 HP masternodes from dash-network-configs devnet-moutai.inventory,
  // in inventory order (hp-masternode-1..13). Every one reported ENABLED with
  // a successful DAPI version check via the quorum service's /masternodes
  // endpoint, so none are pruned. Trusted mode discovers addresses from the
  // quorum context; this list is what the islock DAPI stream and the
  // network-health indicator dial directly.
  dapiAddresses: [
    'https://68.67.122.254:1443',
    'https://68.67.122.207:1443',
    'https://68.67.122.192:1443',
    'https://68.67.122.194:1443',
    'https://68.67.122.195:1443',
    'https://68.67.122.196:1443',
    'https://68.67.122.253:1443',
    'https://68.67.122.198:1443',
    'https://68.67.122.199:1443',
    'https://68.67.122.84:1443',
    'https://68.67.122.206:1443',
    'https://68.67.122.252:1443',
    'https://68.67.122.197:1443',
  ],
  // No faucetBaseUrl: moutai's faucet.moutai.networks.dash.org is the legacy
  // PHP MultiFaucet (reCAPTCHA), which serves no /api/status, so wiring it up
  // would render an in-app faucet button that only ever 404s. Fund the deposit
  // address from that page by hand instead.
  useTrustedContext: true,
  // No explicit trustedQuorumUrl — the SDK's default for a devnet named
  // `moutai` resolves to `https://quorums.moutai.networks.dash.org/quorums`,
  // which is deployed and also serves /masternodes and /previous.
};

const NETWORK_REGISTRY = new Map<string, NetworkConfig>([
  ['testnet', TESTNET],
  ['mainnet', MAINNET],
  ['devnet-moutai', DEVNET_MOUTAI],
]);

const CUSTOM_DEVNETS_KEY = 'bridge-custom-devnets';

export const RESERVED_NETWORK_NAMES: ReadonlySet<string> = new Set(['testnet', 'mainnet']);

export function isReservedNetworkName(name: string): boolean {
  return RESERVED_NETWORK_NAMES.has(name);
}

function loadCustomDevnets(): NetworkConfig[] {
  try {
    const stored = localStorage.getItem(CUSTOM_DEVNETS_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (c): c is NetworkConfig =>
        c &&
        typeof c.name === 'string' &&
        !RESERVED_NETWORK_NAMES.has(c.name) &&
        c.type === 'devnet' &&
        typeof c.addressPrefix === 'number' &&
        typeof c.wifPrefix === 'number' &&
        typeof c.minFee === 'number' &&
        typeof c.dustThreshold === 'number' &&
        typeof c.platformHrp === 'string' &&
        Array.isArray(c.dapiAddresses) &&
        c.dapiAddresses.length > 0 &&
        c.dapiAddresses.every((a: unknown) => typeof a === 'string') &&
        (c.useTrustedContext === undefined || typeof c.useTrustedContext === 'boolean') &&
        (c.trustedQuorumUrl === undefined || typeof c.trustedQuorumUrl === 'string')
    );
    // Devnets saved before p2shPrefix existed default to the testnet/devnet value.
    return valid.map((c) => (typeof c.p2shPrefix === 'number' ? c : { ...c, p2shPrefix: 19 }));
  } catch {
    return [];
  }
}

export function saveCustomDevnet(config: NetworkConfig): void {
  if (RESERVED_NETWORK_NAMES.has(config.name)) {
    throw new Error(`Cannot save custom devnet with reserved name "${config.name}"`);
  }
  const customs = loadCustomDevnets().filter((c) => c.name !== config.name);
  customs.push(config);
  localStorage.setItem(CUSTOM_DEVNETS_KEY, JSON.stringify(customs));
  NETWORK_REGISTRY.set(config.name, config);
}

export function removeCustomDevnet(name: string): void {
  if (RESERVED_NETWORK_NAMES.has(name)) {
    throw new Error(`Cannot remove reserved network "${name}"`);
  }
  const customs = loadCustomDevnets().filter((c) => c.name !== name);
  localStorage.setItem(CUSTOM_DEVNETS_KEY, JSON.stringify(customs));
  NETWORK_REGISTRY.delete(name);
}

export function createCustomDevnetConfig(params: {
  name: string;
  dapiAddresses: string[];
  faucetBaseUrl?: string;
  useTrustedContext?: boolean;
  trustedQuorumUrl?: string;
}): NetworkConfig {
  return {
    type: 'devnet',
    name: params.name,
    addressPrefix: 140,
    p2shPrefix: 19,
    wifPrefix: 239,
    minFee: 1000,
    dustThreshold: 546,
    platformHrp: 'tdash',
    dapiAddresses: params.dapiAddresses,
    faucetBaseUrl: params.faucetBaseUrl,
    useTrustedContext: params.useTrustedContext,
    trustedQuorumUrl: params.trustedQuorumUrl,
  };
}

export function initNetworkRegistry(): void {
  for (const config of loadCustomDevnets()) {
    NETWORK_REGISTRY.set(config.name, config);
  }
}

export function getNetwork(name: string): NetworkConfig {
  const config = NETWORK_REGISTRY.get(name);
  if (config) return config;
  console.warn(`Unknown network "${name}", falling back to testnet`);
  return TESTNET;
}

export function getAvailableNetworks(): NetworkConfig[] {
  return Array.from(NETWORK_REGISTRY.values());
}

export function getDerivationNetwork(name: string): 'testnet' | 'mainnet' {
  return name === 'mainnet' ? 'mainnet' : 'testnet';
}

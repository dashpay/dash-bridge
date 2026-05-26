export interface NetworkConfig {
  type: 'testnet' | 'mainnet' | 'devnet';
  name: string;
  insightApiUrl: string;
  addressPrefix: number;
  wifPrefix: number;
  minFee: number;
  dustThreshold: number;
  platformHrp: string;
  faucetBaseUrl?: string;
  dapiAddresses?: string[];
  rpcUrl?: string;
}

export const TESTNET: NetworkConfig = {
  type: 'testnet',
  name: 'testnet',
  insightApiUrl: 'https://insight.testnet.networks.dash.org/insight-api',
  addressPrefix: 140,
  wifPrefix: 239,
  minFee: 1000,
  dustThreshold: 546,
  platformHrp: 'tdash',
  faucetBaseUrl: 'https://faucet.thepasta.org',
  rpcUrl: 'https://trpc.digitalcash.dev',
};

export const MAINNET: NetworkConfig = {
  type: 'mainnet',
  name: 'mainnet',
  insightApiUrl: 'https://insight.dash.org/insight-api',
  addressPrefix: 76,
  wifPrefix: 204,
  minFee: 1000,
  dustThreshold: 546,
  platformHrp: 'dash',
  rpcUrl: 'https://rpc.digitalcash.dev',
};

export const DEVNET_PALOMA: NetworkConfig = {
  type: 'devnet',
  name: 'devnet-paloma',
  insightApiUrl: 'https://insight.paloma.networks.dash.org/insight-api',
  addressPrefix: 140,
  wifPrefix: 239,
  minFee: 1000,
  dustThreshold: 546,
  platformHrp: 'tdash',
  dapiAddresses: [
    'https://68.67.122.198:1443',
    'https://68.67.122.199:1443',
    'https://68.67.122.86:1443',
    'https://68.67.122.197:1443',
    'https://68.67.122.192:1443',
    'https://68.67.122.85:1443',
    'https://68.67.122.88:1443',
    'https://68.67.122.206:1443',
    'https://68.67.122.193:1443',
    'https://68.67.122.195:1443',
    'https://68.67.122.196:1443',
    'https://68.67.122.87:1443',
    'https://68.67.122.207:1443',
  ],
  faucetBaseUrl: 'https://faucet.paloma.networks.dash.org',
};

const NETWORK_REGISTRY = new Map<string, NetworkConfig>([
  ['testnet', TESTNET],
  ['mainnet', MAINNET],
  ['devnet-paloma', DEVNET_PALOMA],
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
    return parsed.filter(
      (c): c is NetworkConfig =>
        c &&
        typeof c.name === 'string' &&
        !RESERVED_NETWORK_NAMES.has(c.name) &&
        c.type === 'devnet' &&
        typeof c.insightApiUrl === 'string' &&
        typeof c.addressPrefix === 'number' &&
        typeof c.wifPrefix === 'number' &&
        typeof c.minFee === 'number' &&
        typeof c.dustThreshold === 'number' &&
        typeof c.platformHrp === 'string' &&
        Array.isArray(c.dapiAddresses) &&
        c.dapiAddresses.length > 0 &&
        c.dapiAddresses.every((a: unknown) => typeof a === 'string')
    );
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
  insightApiUrl: string;
  dapiAddresses: string[];
  rpcUrl?: string;
  faucetBaseUrl?: string;
}): NetworkConfig {
  return {
    type: 'devnet',
    name: params.name,
    insightApiUrl: params.insightApiUrl,
    addressPrefix: 140,
    wifPrefix: 239,
    minFee: 1000,
    dustThreshold: 546,
    platformHrp: 'tdash',
    dapiAddresses: params.dapiAddresses,
    rpcUrl: params.rpcUrl,
    faucetBaseUrl: params.faucetBaseUrl,
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

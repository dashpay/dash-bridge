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

export const DEVNET_PORTER: NetworkConfig = {
  type: 'devnet',
  name: 'devnet-porter',
  insightApiUrl: 'https://insight.porter.networks.dash.org/insight-api',
  addressPrefix: 140,
  wifPrefix: 239,
  minFee: 1000,
  dustThreshold: 546,
  platformHrp: 'tdash',
  dapiAddresses: [
    'https://44.247.149.200:1443',
    'https://54.70.124.48:1443',
    'https://34.209.64.250:1443',
    'https://34.217.209.121:1443',
    'https://44.255.39.178:1443',
    'https://35.88.212.218:1443',
    'https://34.221.172.217:1443',
    'https://52.89.161.171:1443',
    'https://35.90.237.76:1443',
    'https://35.88.158.240:1443',
    'https://34.221.127.165:1443',
  ],
  faucetBaseUrl: 'https://faucet.porter.networks.dash.org',
};

const NETWORK_REGISTRY = new Map<string, NetworkConfig>([
  ['testnet', TESTNET],
  ['mainnet', MAINNET],
  ['devnet-porter', DEVNET_PORTER],
]);

const CUSTOM_DEVNETS_KEY = 'bridge-custom-devnets';

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
        c.type === 'devnet' &&
        typeof c.insightApiUrl === 'string' &&
        typeof c.addressPrefix === 'number' &&
        typeof c.wifPrefix === 'number' &&
        typeof c.platformHrp === 'string'
    );
  } catch {
    return [];
  }
}

export function saveCustomDevnet(config: NetworkConfig): void {
  const customs = loadCustomDevnets().filter((c) => c.name !== config.name);
  customs.push(config);
  localStorage.setItem(CUSTOM_DEVNETS_KEY, JSON.stringify(customs));
  NETWORK_REGISTRY.set(config.name, config);
}

export function removeCustomDevnet(name: string): void {
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

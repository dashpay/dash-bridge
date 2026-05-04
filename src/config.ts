export interface NetworkConfig {
  name: 'testnet' | 'mainnet';
  insightApiUrl: string;
  addressPrefix: number;
  wifPrefix: number;
  minFee: number;
  dustThreshold: number;
  platformHrp: string;
  faucetBaseUrl?: string;
}

export const TESTNET: NetworkConfig = {
  name: 'testnet',
  insightApiUrl: 'https://insight.testnet.networks.dash.org/insight-api',
  addressPrefix: 140, // 'y' prefix
  wifPrefix: 239,     // 0xef
  minFee: 1000,       // 0.00001 DASH
  dustThreshold: 546,
  platformHrp: 'tdash',
  faucetBaseUrl: 'https://faucet.thepasta.org',
};

export const MAINNET: NetworkConfig = {
  name: 'mainnet',
  insightApiUrl: 'https://insight.dash.org/insight-api',
  addressPrefix: 76,  // 'X' prefix
  wifPrefix: 204,     // 0xcc
  minFee: 1000,
  dustThreshold: 546,
  platformHrp: 'dash',
};

export function getNetwork(name: 'testnet' | 'mainnet'): NetworkConfig {
  return name === 'mainnet' ? MAINNET : TESTNET;
}

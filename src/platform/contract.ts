import { withRetry, type RetryOptions } from '../utils/retry.js';
import { fetchIdentityWithSdk, withConnectedPlatformSdk } from './client.js';
import { loadSdkModule } from './sdkModule.js';

type DataContractClass = typeof import('@dashevo/evo-sdk').DataContract;
type DataContractJson = import('@dashevo/evo-sdk').DataContractJSON;

const NON_SCHEMA_KEYS = new Set([
  '$formatVersion',
  '$format_version',
  'id',
  'ownerId',
  'owner_id',
  'version',
  'documentSchemas',
  'document_schemas',
  'definitions',
  'schemaDefs',
  'schema_defs',
  'tokens',
  'keywords',
  'description',
  'config',
  'groups',
]);

function normalizeContractConfig(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Contract config must be an object');
  }
  const config = value as Record<string, unknown>;
  if (typeof config.$formatVersion === 'string') {
    return { ...config };
  }
  return { $formatVersion: '0', ...config };
}

function extractSchemaDefs(sourceContract: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidate = sourceContract.schemaDefs ?? sourceContract.definitions;
  if (candidate === undefined || candidate === null) {
    return undefined;
  }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Contract schema definitions must be an object');
  }
  return candidate as Record<string, unknown>;
}

function parseTokenPosition(position: string): number {
  if (!/^(0|[1-9]\d*)$/.test(position)) {
    throw new Error(`Token position must be a canonical non-negative integer: ${position}`);
  }

  const tokenPosition = Number(position);
  if (!Number.isSafeInteger(tokenPosition)) {
    throw new Error(`Token position must be a safe integer: ${position}`);
  }

  return tokenPosition;
}

function normalizeJsonTokenPositions(
  tokens: Record<string, unknown> | undefined,
): Record<number, object> | undefined {
  if (!tokens || Object.keys(tokens).length === 0) {
    return undefined;
  }

  const normalized: Record<number, object> = {};

  for (const [position, config] of Object.entries(tokens)) {
    const tokenPosition = parseTokenPosition(position);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`Token configuration at position ${position} must be an object`);
    }

    normalized[tokenPosition] = config as object;
  }

  return normalized;
}

export function buildDataContractJson(
  ownerId: string,
  identityNonce: bigint,
  sourceContract: Record<string, unknown>,
  DataContract: DataContractClass,
): DataContractJson {
  const contractId = DataContract.generateId(ownerId, identityNonce).toString();
  const documentSchemas = extractDocumentSchemas(sourceContract);
  const tokensValue = sourceContract.tokens;
  if (tokensValue !== undefined && (!tokensValue || typeof tokensValue !== 'object' || Array.isArray(tokensValue))) {
    throw new Error('Contract tokens must be an object keyed by token position');
  }
  const tokens = tokensValue as Record<string, unknown> | undefined;
  const normalizedTokens = normalizeJsonTokenPositions(tokens);
  const contractMetadata: Record<string, unknown> = {};
  const PASSTHROUGH_KEYS = new Set(['keywords', 'description', 'groups']);

  for (const [key, value] of Object.entries(sourceContract)) {
    if (PASSTHROUGH_KEYS.has(key)) {
      contractMetadata[key] = value;
    }
  }

  const config = normalizeContractConfig(sourceContract.config);
  const schemaDefs = extractSchemaDefs(sourceContract);

  return {
    ...contractMetadata,
    $formatVersion: '1',
    id: contractId,
    ownerId,
    version: typeof sourceContract.version === 'number' ? sourceContract.version : 1,
    documentSchemas: documentSchemas as Record<string, object>,
    ...(schemaDefs ? { schemaDefs } : {}),
    ...(config ? { config } : {}),
    ...(normalizedTokens ? { tokens: normalizedTokens } : {}),
  } as DataContractJson;
}

/**
 * Publish a data contract on Dash Platform.
 *
 * @param identityId - Base58 identity ID of the contract owner
 * @param contractJson - Full plain data contract JSON
 * @param publicKeyId - The identity public key ID to sign with
 * @param privateKeyWif - WIF-encoded private key for signing
 * @param network - Target network
 */
export async function publishContract(
  identityId: string,
  contractJson: Record<string, unknown>,
  publicKeyId: number,
  privateKeyWif: string,
  network: string,
  retryOptions?: RetryOptions,
): Promise<{ contractId: string }> {
  return withConnectedPlatformSdk(network, async (sdk) => {
    const identity = await fetchIdentityWithSdk(sdk, identityId, retryOptions);
    if (!identity) {
      throw new Error('Identity not found');
    }

    const identityKey = identity.getPublicKeyById(publicKeyId);
    if (!identityKey) {
      throw new Error(`Identity key ${publicKeyId} not found`);
    }

    const sdkModule = await loadSdkModule();
    const { IdentitySigner, DataContract, PlatformVersion } = sdkModule;
    const signer = new IdentitySigner();
    signer.addKeyFromWif(privateKeyWif);
    const platformVersion = PlatformVersion.latest();

    console.log('Creating data contract...');
    // Placeholder nonce mirrors the constructor path this replaced; SDK publish
    // still handles the real transition nonce when broadcasting the contract.
    const dataContractJson = buildDataContractJson(
      identityId,
      0n,
      contractJson,
      DataContract,
    );

    const dataContract = DataContract.fromJSON(dataContractJson, true, platformVersion);

    console.log('Publishing contract...');
    const published = await withRetry(
      () => sdk.contracts.publish({
        dataContract,
        identityKey,
        signer,
      }),
      retryOptions,
    );

    const contractId = published.id.toString();
    console.log('Contract published:', contractId);

    return { contractId };
  }, retryOptions);
}

/**
 * Extract document schemas from a contract JSON object.
 * Handles both full format (with `documentSchemas` key) and document-only format.
 */
export function extractDocumentSchemas(contractJson: Record<string, unknown>): Record<string, unknown> {
  if (contractJson.documentSchemas && typeof contractJson.documentSchemas === 'object') {
    return contractJson.documentSchemas as Record<string, unknown>;
  }
  // Document-only format: filter out known non-schema keys
  const schemas: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(contractJson)) {
    if (!NON_SCHEMA_KEYS.has(key) && val && typeof val === 'object') {
      const v = val as Record<string, unknown>;
      if (v.type === 'object' || Array.isArray(v.indices)) {
        schemas[key] = val;
      }
    }
  }
  return schemas;
}

import { IdentitySigner, DataContract } from '@dashevo/evo-sdk';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import { fetchIdentityWithSdk, withConnectedPlatformSdk } from './client.js';

/**
 * Publish a data contract on Dash Platform.
 *
 * @param identityId - Base58 identity ID of the contract owner
 * @param documentSchemas - The document schemas object (the value of `documentSchemas` from contract JSON)
 * @param tokens - Optional token configurations (keyed by position string)
 * @param publicKeyId - The identity public key ID to sign with
 * @param privateKeyWif - WIF-encoded private key for signing
 * @param network - Target network
 */
export async function publishContract(
  identityId: string,
  documentSchemas: Record<string, unknown>,
  tokens: Record<string, unknown> | undefined,
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

    const signer = new IdentitySigner();
    signer.addKeyFromWif(privateKeyWif);

    console.log('Creating data contract...');
    const contractOptions = {
      ownerId: identityId,
      identityNonce: 0n, // Placeholder: SDK's put_to_platform_and_wait_for_response fetches the real nonce
      schemas: documentSchemas as Record<string, object>,
      fullValidation: true,
      ...(tokens && Object.keys(tokens).length > 0 ? { tokens } : {}),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataContract = new DataContract(contractOptions as any);

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
  const nonSchemaKeys = new Set(['$formatVersion', 'id', 'ownerId', 'version', 'tokens', 'keywords', 'config', 'groups']);
  const schemas: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(contractJson)) {
    if (!nonSchemaKeys.has(key) && val && typeof val === 'object') {
      const v = val as Record<string, unknown>;
      if (v.type === 'object' || Array.isArray(v.indices)) {
        schemas[key] = val;
      }
    }
  }
  return schemas;
}

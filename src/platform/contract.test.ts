import { describe, expect, it, beforeAll } from 'vitest';
import {
  DataContract,
  PlatformVersion,
  TokenConfiguration,
  ensureInitialized,
} from '@dashevo/evo-sdk';
import { buildDataContractJson } from './contract.js';

const ownerId = '11111111111111111111111111111111';
const schemas = {
  note: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        position: 0,
      },
    },
    additionalProperties: false,
  },
};

const schemasWithDefinitions = {
  note: {
    type: 'object',
    properties: {
      title: {
        $ref: '#/$defs/localizedString',
        position: 0,
      },
    },
    additionalProperties: false,
  },
};

const changeRules = {
  $formatVersion: '0',
  authorizedToMakeChange: 'NoOne',
  adminActionTakers: 'NoOne',
  changingAuthorizedActionTakersToNoOneAllowed: false,
  changingAdminActionTakersToNoOneAllowed: false,
  selfChangingAdminActionTakersAllowed: false,
};

const tokenJson = {
  $formatVersion: '0',
  conventions: {
    $formatVersion: '0',
    localizations: {
      en: {
        $formatVersion: '0',
        shouldCapitalize: false,
        singularForm: 'credit',
        pluralForm: 'credits',
      },
    },
    decimals: 8,
  },
  conventionsChangeRules: changeRules,
  baseSupply: 0,
  maxSupply: null,
  keepsHistory: {
    $formatVersion: '0',
    keepsTransferHistory: false,
    keepsFreezingHistory: false,
    keepsMintingHistory: false,
    keepsBurningHistory: false,
    keepsDirectPricingHistory: false,
    keepsDirectPurchaseHistory: false,
  },
  startAsPaused: false,
  allowTransferToFrozenBalance: false,
  maxSupplyChangeRules: changeRules,
  distributionRules: {
    $formatVersion: '0',
    perpetualDistribution: null,
    perpetualDistributionRules: changeRules,
    preProgrammedDistribution: null,
    newTokensDestinationIdentity: null,
    newTokensDestinationIdentityRules: changeRules,
    mintingAllowChoosingDestination: false,
    mintingAllowChoosingDestinationRules: changeRules,
    changeDirectPurchasePricingRules: changeRules,
  },
  marketplaceRules: {
    $formatVersion: '0',
    tradeMode: 'NotTradeable',
    tradeModeChangeRules: changeRules,
  },
  manualMintingRules: changeRules,
  manualBurningRules: changeRules,
  freezeRules: changeRules,
  unfreezeRules: changeRules,
  destroyFrozenFundsRules: changeRules,
  emergencyActionRules: changeRules,
  mainControlGroup: null,
  mainControlGroupCanBeModified: 'NoOne',
  description: null,
};

describe('contract token normalization', () => {
  beforeAll(async () => {
    await ensureInitialized();
  });

  it('documents that evo-sdk rc.2 rejects raw token JSON', () => {
    expect(() => new DataContract({
      ownerId,
      identityNonce: 0n,
      schemas,
      fullValidation: true,
      tokens: { 0: tokenJson } as unknown as Record<number, TokenConfiguration>,
    })).toThrow(/TokenConfiguration/);
  });

  it('builds token contracts from plain JSON through the rc.2 fromJSON path', () => {
    const platformVersion = PlatformVersion.latest();
    const contractJson = buildDataContractJson(
      ownerId,
      0n,
      {
        documentSchemas: schemas,
        tokens: { '0': tokenJson },
      },
      DataContract,
    );

    expect(contractJson.tokens?.[0]).toEqual(tokenJson);
    const dataContract = DataContract.fromJSON(contractJson, true, platformVersion);
    expect(dataContract.id.toString()).toBe(contractJson.id);
  });

  it('preserves contract-level JSON metadata under the rc.2 keys and survives fromJSON', () => {
    const platformVersion = PlatformVersion.latest();
    const schemaDefinitions = {
      localizedString: {
        type: 'object',
        properties: {
          en: { type: 'string' },
        },
      },
    };
    const rawConfig = {
      canBeDeleted: true,
      readonly: false,
      keepsHistory: false,
      documentsKeepHistoryContractDefault: false,
      documentsMutableContractDefault: true,
      documentsCanBeDeletedContractDefault: true,
    };
    const contractJson = buildDataContractJson(
      ownerId,
      0n,
      {
        documentSchemas: schemas,
        definitions: schemaDefinitions,
        keywords: ['bridge'],
        description: 'Bridge contract',
        config: rawConfig,
        groups: {
          0: {
            $formatVersion: '0',
            members: {
              [ownerId]: 1,
            },
            requiredPower: 1,
          },
        },
        tokens: { '0': tokenJson },
      },
      DataContract,
    );

    expect(contractJson).toMatchObject({
      schemaDefs: schemaDefinitions,
      keywords: ['bridge'],
      description: 'Bridge contract',
      config: { $formatVersion: '0', canBeDeleted: true },
      groups: {
        0: { requiredPower: 1 },
      },
    });
    expect(contractJson).not.toHaveProperty('definitions');

    const dataContract = DataContract.fromJSON(contractJson, true, platformVersion);
    const roundTrippedJson = dataContract.toJSON(platformVersion);

    expect(roundTrippedJson.schemaDefs).toEqual(schemaDefinitions);
    expect(roundTrippedJson).not.toHaveProperty('definitions');
    expect(roundTrippedJson.config).toMatchObject({
      $formatVersion: '0',
      ...rawConfig,
    });
  });

  it('normalizes contract config without a $formatVersion so fromJSON accepts it', () => {
    const platformVersion = PlatformVersion.latest();
    const contractJson = buildDataContractJson(
      ownerId,
      0n,
      {
        documentSchemas: schemas,
        config: {
          canBeDeleted: true,
          readonly: false,
          keepsHistory: false,
          documentsKeepHistoryContractDefault: false,
          documentsMutableContractDefault: true,
          documentsCanBeDeletedContractDefault: true,
        },
      },
      DataContract,
    );

    expect(contractJson.config).toMatchObject({
      $formatVersion: '0',
      canBeDeleted: true,
      readonly: false,
      keepsHistory: false,
      documentsKeepHistoryContractDefault: false,
      documentsMutableContractDefault: true,
      documentsCanBeDeletedContractDefault: true,
    });

    const dataContract = DataContract.fromJSON(contractJson, true, platformVersion);
    expect(dataContract.toJSON(platformVersion).config).toMatchObject({
      $formatVersion: '0',
      canBeDeleted: true,
      readonly: false,
      keepsHistory: false,
      documentsKeepHistoryContractDefault: false,
      documentsMutableContractDefault: true,
      documentsCanBeDeletedContractDefault: true,
    });
  });

  it('accepts schemaDefs input referenced by documents and writes it under schemaDefs for fromJSON', () => {
    const platformVersion = PlatformVersion.latest();
    const schemaDefinitions = {
      localizedString: {
        type: 'object',
        properties: {
          en: {
            type: 'string',
            position: 0,
          },
        },
        additionalProperties: false,
      },
    };
    const contractJson = buildDataContractJson(
      ownerId,
      0n,
      {
        documentSchemas: schemasWithDefinitions,
        schemaDefs: schemaDefinitions,
        description: 'Contract with shared definitions',
      },
      DataContract,
    );

    expect(contractJson.schemaDefs).toEqual(schemaDefinitions);
    expect(contractJson.description).toBe('Contract with shared definitions');
    expect(contractJson).not.toHaveProperty('definitions');
    const dataContract = DataContract.fromJSON(contractJson, true, platformVersion);
    expect(dataContract.toJSON(platformVersion).schemaDefs).toEqual(schemaDefinitions);
  });

  it('rejects non-canonical token position keys before they can alias', () => {
    expect(() => buildDataContractJson(
      ownerId,
      0n,
      {
        documentSchemas: schemas,
        tokens: {
          '01': tokenJson,
        },
      },
      DataContract,
    )).toThrow('Token position must be a canonical non-negative integer: 01');
  });
});

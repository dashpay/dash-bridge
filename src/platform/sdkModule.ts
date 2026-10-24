import evoSdkChunkUrl from 'virtual:chunk-url:@dashevo/evo-sdk';
import { createChunkLoader } from './chunk-loader.js';

export type SdkModule = typeof import('@dashevo/evo-sdk');

export const loadSdkModule = createChunkLoader('evo-sdk', evoSdkChunkUrl, () => import('@dashevo/evo-sdk'));

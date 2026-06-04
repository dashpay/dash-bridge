import { createCachedLoader } from './loaders.js';

export type SdkModule = typeof import('@dashevo/evo-sdk');

export const loadSdkModule = createCachedLoader(() => import('@dashevo/evo-sdk'));

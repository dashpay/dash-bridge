import { describe, expect, it } from 'vitest';

import { shouldPreloadDashChunk } from './vite-preload.js';

describe('shouldPreloadDashChunk', () => {
  it('filters heavy Dash chunks out of Vite modulepreload dependencies', () => {
    expect(shouldPreloadDashChunk('assets/evo-sdk.module-Cqrfhinu.js')).toBe(false);
    expect(shouldPreloadDashChunk('assets/dapi-client-Bn7.js')).toBe(false);
    expect(shouldPreloadDashChunk('assets/dashcore-lib-Cx9.js')).toBe(false);
    expect(shouldPreloadDashChunk('assets/dapi-subscription-Dk2.js')).toBe(false);
    expect(shouldPreloadDashChunk('assets/islock-Ea3.js')).toBe(false);
  });

  it('keeps normal chunks preloadable', () => {
    expect(shouldPreloadDashChunk('assets/index-D6CSvW9B.js')).toBe(true);
    expect(shouldPreloadDashChunk('assets/components-Ba1.js')).toBe(true);
    expect(shouldPreloadDashChunk('assets/style-Ca2.css')).toBe(true);
  });
});

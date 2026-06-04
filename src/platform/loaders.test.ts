import { describe, expect, it } from 'vitest';

import { createCachedLoader } from './loaders.js';

describe('createCachedLoader', () => {
  it('reuses one in-flight promise for concurrent calls', async () => {
    let calls = 0;
    let resolveLoad: ((value: string) => void) | undefined;
    const loader = createCachedLoader(() => {
      calls += 1;
      return new Promise<string>((resolve) => {
        resolveLoad = resolve;
      });
    });

    const first = loader();
    const second = loader();

    expect(first).toBe(second);
    expect(calls).toBe(1);

    resolveLoad?.('ready');
    await expect(first).resolves.toBe('ready');
    await expect(second).resolves.toBe('ready');
  });

  it('clears a rejected promise so a later call can retry', async () => {
    let calls = 0;
    const loader = createCachedLoader(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('chunk failed');
      }
      return 'recovered';
    });

    await expect(loader()).rejects.toThrow('chunk failed');
    await expect(loader()).resolves.toBe('recovered');
    expect(calls).toBe(2);
  });
});

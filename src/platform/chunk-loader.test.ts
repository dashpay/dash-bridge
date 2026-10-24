import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChunkLoadError, cacheBustedUrl, createChunkLoader, isChunkLoadError } from './chunk-loader.js';

const noSleep = { sleep: async () => {} };

describe('createChunkLoader', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses one in-flight promise for concurrent calls', async () => {
    let calls = 0;
    let resolveLoad: ((value: string) => void) | undefined;
    const loader = createChunkLoader('x', null, () => {
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

  it('retries the plain import with backoff when the chunk URL is unknown', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const loader = createChunkLoader('x', null, async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('Importing a module script failed.');
      return 'loaded';
    }, { sleep: async (ms) => { sleeps.push(ms); } });

    await expect(loader()).resolves.toBe('loaded');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1500]);
  });

  it('retries under a cache-busted chunk URL, because a failed import() is remembered per URL', async () => {
    const importUrl = vi.fn(async (url: string) => ({ from: url }));
    const load = vi.fn(async () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    const loader = createChunkLoader(
      'evo-sdk',
      'https://bridge.example/assets/evo-sdk.module-abc.js',
      load,
      { ...noSleep, importUrl }
    );

    const mod = (await loader()) as unknown as { from: string };
    expect(load).toHaveBeenCalledTimes(1);
    expect(importUrl).toHaveBeenCalledTimes(1);
    const url = new URL(mod.from);
    expect(url.origin + url.pathname).toBe('https://bridge.example/assets/evo-sdk.module-abc.js');
    expect(url.searchParams.get('retry')).toMatch(/^1\./);
  });

  it('gives up after 3 attempts with a ChunkLoadError naming the chunk, logs each failure, then lets a later call start over', async () => {
    let calls = 0;
    const loader = createChunkLoader('evo-sdk', null, async () => {
      calls += 1;
      if (calls <= 3) throw new TypeError('Importing a module script failed.');
      return 'recovered';
    }, noSleep);

    const error = await loader().catch((e: unknown) => e);
    expect(isChunkLoadError(error)).toBe(true);
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).chunk).toBe('evo-sdk');
    expect((error as ChunkLoadError).attempts).toBe(3);
    expect((error as ChunkLoadError).message).toBe(
      'Could not load the "evo-sdk" component after 3 attempts: Importing a module script failed.'
    );
    const warn = vi.mocked(console.warn);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0][0])).toContain('Chunk "evo-sdk" failed to load (attempt 1/3); retrying in 500 ms');
    expect(String(warn.mock.calls[2][0])).toContain('(attempt 3/3)');

    await expect(loader()).resolves.toBe('recovered');
    expect(calls).toBe(4);
  });
});

describe('cacheBustedUrl', () => {
  it('keeps the path, adds a per-attempt retry parameter and preserves other query params', () => {
    const a = new URL(cacheBustedUrl('https://h.example/a/chunk.js?x=1', 1));
    const b = new URL(cacheBustedUrl('https://h.example/a/chunk.js?x=1', 2));
    expect(a.pathname).toBe('/a/chunk.js');
    expect(a.searchParams.get('x')).toBe('1');
    expect(a.searchParams.get('retry')).not.toBe(b.searchParams.get('retry'));
  });
});

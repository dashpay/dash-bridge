import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChunkLoadError, cacheBustedUrl, createChunkLoader, noteDownloadStarted, withChunkTimeout } from './chunk-loader.js';

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

  it('never reuses a failed URL in a later round, as the browser would answer it from its module map', async () => {
    const failed = new Set<string>();
    let networkUp = false;
    const requests: string[] = [];
    const importUrl = async (url: string) => {
      if (failed.has(url)) throw new TypeError('Importing a module script failed.'); // no request
      requests.push(url);
      if (!networkUp) {
        failed.add(url);
        throw new TypeError('Importing a module script failed.');
      }
      return { url };
    };
    const chunkUrl = 'https://bridge.example/assets/evo-sdk.module-abc.js';
    const loader = createChunkLoader('evo-sdk', chunkUrl, () => importUrl(chunkUrl), { ...noSleep, importUrl });

    await expect(loader()).rejects.toBeInstanceOf(ChunkLoadError);
    expect(requests).toHaveLength(3);
    networkUp = true;
    await expect(loader()).resolves.toBeTruthy();
    expect(requests).toHaveLength(4);
    expect(new Set(requests).size).toBe(4);
  });

  it('makes concurrent callers during a failing round share one request sequence and one error', async () => {
    const requests: string[] = [];
    const importUrl = async (url: string) => {
      requests.push(url);
      throw new TypeError('Importing a module script failed.');
    };
    const chunkUrl = 'https://bridge.example/assets/evo-sdk.module-abc.js';
    const loader = createChunkLoader('evo-sdk', chunkUrl, () => importUrl(chunkUrl), { ...noSleep, importUrl });

    const [a, b] = await Promise.all([loader().catch((e: unknown) => e), loader().catch((e: unknown) => e)]);
    expect(a).toBeInstanceOf(ChunkLoadError);
    expect(b).toBe(a);
    expect(requests).toHaveLength(3);
  });

  it('does not retry an error that is not a failed download', async () => {
    let calls = 0;
    const loader = createChunkLoader('x', 'https://h.example/x.js', async () => {
      calls += 1;
      throw new SyntaxError('Unexpected token');
    }, noSleep);
    const error = (await loader().catch((e: unknown) => e)) as ChunkLoadError;
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect(error.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('gives up after 3 attempts with a ChunkLoadError naming the chunk, logs each failure, then lets a later call start over', async () => {
    let calls = 0;
    const loader = createChunkLoader('evo-sdk', null, async () => {
      calls += 1;
      if (calls <= 3) throw new TypeError('Importing a module script failed.');
      return 'recovered';
    }, noSleep);

    const error = await loader().catch((e: unknown) => e);
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

describe('createChunkLoader right after a file download started', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    noteDownloadStarted(0); // long ago: outside the prompt window again
    vi.restoreAllMocks();
  });

  it('keeps retrying for about a minute, since an open download prompt fails every load until answered', async () => {
    noteDownloadStarted();
    const sleeps: number[] = [];
    let calls = 0;
    const loader = createChunkLoader('evo-sdk', null, async () => {
      calls += 1;
      if (calls < 5) throw new TypeError('Importing a module script failed.');
      return 'loaded';
    }, { sleep: async (ms) => { sleeps.push(ms); } });

    await expect(loader()).resolves.toBe('loaded');
    expect(sleeps).toEqual([2000, 5000, 10000, 15000]);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('its prompt may be blocking loads');
  });

  it('flags the download prompt on the error when it never clears', async () => {
    noteDownloadStarted();
    const loader = createChunkLoader('evo-sdk', null, async () => {
      throw new TypeError('Importing a module script failed.');
    }, noSleep);

    const error = (await loader().catch((e: unknown) => e)) as ChunkLoadError;
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect(error.attempts).toBe(6);
    expect(error.downloadPromptSuspected).toBe(true);
  });

  it('picks the backoff at the first failure only: a download during the round does not stretch it', async () => {
    const sleeps: number[] = [];
    const loader = createChunkLoader('x', null, async () => {
      throw new TypeError('Importing a module script failed.');
    }, { sleep: async (ms) => { sleeps.push(ms); noteDownloadStarted(); } });

    const error = (await loader().catch((e: unknown) => e)) as ChunkLoadError;
    expect(sleeps).toEqual([500, 1500]);
    expect(error.attempts).toBe(3);
    expect(error.downloadPromptSuspected).toBe(false);
  });

  it('uses the short backoff once the download is long past', async () => {
    noteDownloadStarted(Date.now() - 61_000);
    const sleeps: number[] = [];
    const loader = createChunkLoader('x', null, async () => {
      throw new TypeError('Importing a module script failed.');
    }, { sleep: async (ms) => { sleeps.push(ms); } });

    const error = (await loader().catch((e: unknown) => e)) as ChunkLoadError;
    expect(sleeps).toEqual([500, 1500]);
    expect(error.downloadPromptSuspected).toBe(false);
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

describe('withChunkTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a ChunkLoadError naming the stalled chunk', async () => {
    vi.useFakeTimers();
    const stalled = withChunkTimeout(new Promise<never>(() => {}), 'platform', 300_000).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(300_000);
    const error = (await stalled) as ChunkLoadError;
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect(error.chunk).toBe('platform');
    expect(error.message).toContain('still loading after 300 s');
  });

  it('passes a load that finishes in time through', async () => {
    await expect(withChunkTimeout(Promise.resolve('ok'), 'evo-sdk', 1000)).resolves.toBe('ok');
  });
});

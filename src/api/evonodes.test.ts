import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MIN_DYNAMIC_EVONODES,
  TESTNET_MASTERNODES_URL,
  parseEvonodeAddresses,
  resolveDapiAddresses,
  resolveTestnetDapiAddresses,
} from './evonodes.js';

const node = (host: string, overrides: Record<string, unknown> = {}) => ({
  proTxHash: 'aa',
  address: `${host}:19999`,
  addresses: { platform_https: [`${host}:1443`] },
  status: 'ENABLED',
  platformHTTPPort: 1443,
  versionCheck: 'success',
  ...overrides,
});

const payload = (...nodes: unknown[]) => ({ success: true, data: nodes });

const FALLBACK = ['https://1.1.1.1:1443', 'https://1.1.1.2:1443', 'https://1.1.1.3:1443'];

describe('parseEvonodeAddresses', () => {
  it('keeps ENABLED nodes with a successful version check and maps them to :1443', () => {
    const result = parseEvonodeAddresses(
      payload(
        node('68.67.122.1'),
        node('68.67.122.2', { status: 'POSE_BANNED' }),
        node('68.67.122.3', { versionCheck: 'fail' }),
        node('68.67.122.4', { versionCheck: undefined }),
        node('85.209.243.1')
      )
    );

    expect(result).toEqual(['https://68.67.122.1:1443', 'https://85.209.243.1:1443']);
  });

  it('ignores the Core P2P port and de-duplicates by host', () => {
    const result = parseEvonodeAddresses(
      payload(node('68.67.122.1'), node('68.67.122.1', { address: '68.67.122.1:12345' }))
    );

    expect(result).toEqual(['https://68.67.122.1:1443']);
  });

  it('accepts DNS names but drops unsafe or malformed hosts', () => {
    const result = parseEvonodeAddresses(
      payload(
        node('evo1.example.org'),
        node('x', { address: 'user@evil.example:19999' }),
        node('x', { address: 'host/path:19999' }),
        node('x', { address: '[::1]:19999' }),
        node('999.1.1.1'),
        node('1.2.3.4.5'),
        node('x', { address: '' }),
        node('x', { address: 42 }),
        null,
        'junk'
      )
    );

    expect(result).toEqual(['https://evo1.example.org:1443']);
  });

  it.each([undefined, null, 'x', {}, { data: {} }, { success: false }])(
    'returns nothing for malformed payload %j',
    (bad) => {
      expect(parseEvonodeAddresses(bad)).toEqual([]);
    }
  );
});

describe('resolveTestnetDapiAddresses', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const respond = (body: unknown, ok = true) =>
    fetchMock.mockResolvedValue({
      ok,
      status: ok ? 200 : 503,
      statusText: ok ? 'OK' : 'Service Unavailable',
      json: async () => body,
    });

  it('uses only the live list when it has enough nodes', async () => {
    respond(payload(node('10.0.0.1'), node('10.0.0.2'), node('10.0.0.3'), node('10.0.0.4')));

    const result = await resolveTestnetDapiAddresses(FALLBACK);

    expect(result).toEqual([
      'https://10.0.0.1:1443',
      'https://10.0.0.2:1443',
      'https://10.0.0.3:1443',
      'https://10.0.0.4:1443',
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(TESTNET_MASTERNODES_URL);
  });

  it(`tops up with the static list below ${MIN_DYNAMIC_EVONODES} live nodes, without duplicates`, async () => {
    respond(payload(node('10.0.0.1'), node('1.1.1.2')));

    const result = await resolveTestnetDapiAddresses(FALLBACK);

    expect(result).toEqual([
      'https://10.0.0.1:1443',
      'https://1.1.1.2:1443',
      'https://1.1.1.1:1443',
      'https://1.1.1.3:1443',
    ]);
  });

  it('falls back to the static list when no node is healthy', async () => {
    respond(payload(node('10.0.0.1', { status: 'POSE_BANNED' })));

    await expect(resolveTestnetDapiAddresses(FALLBACK)).resolves.toEqual(FALLBACK);
  });

  it('falls back to the static list on a network error, without retrying', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(resolveTestnetDapiAddresses(FALLBACK)).resolves.toEqual(FALLBACK);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to the static list on an HTTP error', async () => {
    respond({}, false);

    await expect(resolveTestnetDapiAddresses(FALLBACK)).resolves.toEqual(FALLBACK);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to the static list on invalid JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    await expect(resolveTestnetDapiAddresses(FALLBACK)).resolves.toEqual(FALLBACK);
  });

  describe('resolveDapiAddresses', () => {
    it('resolves the live list for testnet', async () => {
      respond(payload(node('10.0.0.1'), node('10.0.0.2'), node('10.0.0.3')));

      const result = await resolveDapiAddresses({ type: 'testnet', dapiAddresses: FALLBACK });

      expect(result).toHaveLength(3);
      expect(result?.[0]).toBe('https://10.0.0.1:1443');
    });

    it('makes no request for devnets, mainnet or networks without addresses', async () => {
      const devnet = ['https://68.67.122.254:1443'];

      await expect(resolveDapiAddresses({ type: 'devnet', dapiAddresses: devnet })).resolves.toBe(devnet);
      await expect(resolveDapiAddresses({ type: 'mainnet' })).resolves.toBeUndefined();
      await expect(resolveDapiAddresses({ type: 'testnet' })).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('gives up after the timeout and uses the static list', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        })
    );

    const result = resolveTestnetDapiAddresses(FALLBACK);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(result).resolves.toEqual(FALLBACK);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

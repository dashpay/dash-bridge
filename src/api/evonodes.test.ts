import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TESTNET_MASTERNODES_URL,
  fetchTestnetEvonodeAddresses,
  parseEvonodeAddresses,
  toDapiEndpoint,
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
        node('user@evil.example'),
        node('host/path'),
        node('[::1]'),
        node('999.1.1.1'),
        node('1.2.3.4.5'),
        // Records without platform_https fall back to the Core host.
        node('x', { address: 'user@evil.example:19999', addresses: undefined }),
        node('x', { address: '', addresses: undefined }),
        node('x', { address: 42, addresses: undefined }),
        node('x', { address: undefined, addresses: { platform_https: ['no-port'] } }),
        node('x', { address: undefined, addresses: { platform_https: ['10.0.0.1:0'] } }),
        null,
        'junk'
      )
    );

    expect(result).toEqual(['https://evo1.example.org:1443']);
  });

  it('uses the platform_https endpoint, which can differ from the Core P2P host', () => {
    const result = parseEvonodeAddresses(
      payload(
        node('68.67.122.3', { addresses: { core_p2p: ['68.67.122.3:19999'], platform_https: ['evo3.example.org:443'] } }),
        node('68.67.122.4', { addresses: undefined })
      )
    );

    expect(result).toEqual(['https://evo3.example.org:443', 'https://68.67.122.4:1443']);
  });

  it.each([undefined, null, 'x', {}, { data: {} }, { success: false }])(
    'returns nothing for malformed payload %j',
    (bad) => {
      expect(parseEvonodeAddresses(bad)).toEqual([]);
    }
  );
});

describe('toDapiEndpoint', () => {
  it('builds an https endpoint, defaulting to port 1443', () => {
    expect(toDapiEndpoint('68.67.122.1')).toBe('https://68.67.122.1:1443');
    expect(toDapiEndpoint('68.67.122.1', 443)).toBe('https://68.67.122.1:443');
  });

  it.each([
    ['999.1.1.1', 1443],
    ['[::1]', 1443],
    ['user@host', 1443],
    [undefined, 1443],
    ['68.67.122.1', 0],
    ['68.67.122.1', 70000],
    ['68.67.122.1', Number.NaN],
    ['68.67.122.1', '1443'],
  ])('rejects host %j port %j', (host, port) => {
    expect(toDapiEndpoint(host, port)).toBeUndefined();
  });
});

describe('fetchTestnetEvonodeAddresses', () => {
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

  it('returns the healthy nodes from the quorum service', async () => {
    respond(payload(node('10.0.0.1'), node('10.0.0.2', { status: 'POSE_BANNED' }), node('10.0.0.3')));

    await expect(fetchTestnetEvonodeAddresses()).resolves.toEqual([
      'https://10.0.0.1:1443',
      'https://10.0.0.3:1443',
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(TESTNET_MASTERNODES_URL);
  });

  it('returns nothing on a network error, without retrying', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(fetchTestnetEvonodeAddresses()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns nothing on an HTTP error', async () => {
    respond({}, false);

    await expect(fetchTestnetEvonodeAddresses()).resolves.toEqual([]);
  });

  it('returns nothing on invalid JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    await expect(fetchTestnetEvonodeAddresses()).resolves.toEqual([]);
  });

  it('gives up after the 5 s timeout', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        })
    );

    const result = fetchTestnetEvonodeAddresses();
    await vi.advanceTimersByTimeAsync(5000);

    await expect(result).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

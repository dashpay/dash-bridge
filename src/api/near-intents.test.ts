import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NEAR_INTENTS_API_URL,
  NEAR_INTENTS_DASH_ASSET_ID,
  NearIntentsError,
  fetchNearIntentsTokens,
  formatUnits,
  getNearSwapStatus,
  isNearSwapExpired,
  nearIntentsAppUrl,
  parseDashToDuffs,
  requestNearIntentsQuote,
  selectableSourceTokens,
  validateRefundAddress,
  type NearIntentsToken,
} from './near-intents.js';

const USDC: NearIntentsToken = {
  assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  symbol: 'USDC',
  blockchain: 'eth',
  decimals: 6,
};
const RECIPIENT = 'XanAvE5GMB8CsPH78B9moJq9viEVKvCS4f';
const REFUND = '0x2527D02599Ba641c19FEa793cD0F167589a0f10D';
const NOW = Date.parse('2026-10-07T17:00:00.000Z');

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function quoteResponse(overrides: { quote?: Record<string, unknown>; quoteRequest?: Record<string, unknown> } = {}) {
  return {
    quote: {
      amountIn: '2680000',
      minAmountIn: '2650000',
      amountOut: '5000000',
      minAmountOut: '5000000',
      amountInUsd: '2.68',
      amountOutUsd: '2.65',
      timeEstimate: 134,
      deadline: '2026-10-07T18:00:00.000Z',
      depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8',
      ...overrides.quote,
    },
    quoteRequest: {
      swapType: 'EXACT_OUTPUT',
      originAsset: USDC.assetId,
      destinationAsset: NEAR_INTENTS_DASH_ASSET_ID,
      amount: '5000000',
      recipient: RECIPIENT,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: REFUND,
      refundType: 'ORIGIN_CHAIN',
      depositType: 'ORIGIN_CHAIN',
      ...overrides.quoteRequest,
    },
    signature: 'ed25519:x',
    correlationId: '33a6afea-9d04-460d-add3-b2925e920218',
  };
}

const quoteParams = (dry: boolean) => ({
  originAsset: USDC,
  amountOutDuffs: 5_000_000,
  recipient: RECIPIENT,
  refundTo: REFUND,
  dry,
  now: NOW,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchNearIntentsTokens', () => {
  it('keeps well-formed tokens and drops malformed or duplicate ones', async () => {
    mockFetch(200, [
      { ...USDC, price: 0.9998 },
      { assetId: NEAR_INTENTS_DASH_ASSET_ID, decimals: 8, blockchain: 'dash', symbol: 'DASH' },
      { ...USDC },
      { assetId: 'bad id with spaces', decimals: 6, blockchain: 'eth', symbol: 'X' },
      { assetId: 'nep141:a', decimals: -1, blockchain: 'eth', symbol: 'X' },
      { assetId: 'nep141:b', decimals: 6, blockchain: '<script>', symbol: 'X' },
      { assetId: 'nep141:c', decimals: 6, blockchain: 'eth' },
      null,
    ]);
    const tokens = await fetchNearIntentsTokens();
    expect(tokens).toEqual([
      { ...USDC, priceUsd: 0.9998 },
      { assetId: NEAR_INTENTS_DASH_ASSET_ID, decimals: 8, blockchain: 'dash', symbol: 'DASH' },
    ]);
    expect(selectableSourceTokens(tokens).map((t) => t.symbol)).toEqual(['USDC']);
  });

  it.each([
    ['is missing', [USDC]],
    ['has unexpected decimals', [USDC, { assetId: NEAR_INTENTS_DASH_ASSET_ID, decimals: 6, blockchain: 'dash', symbol: 'DASH' }]],
  ])('refuses the list when DASH %s', async (_case, list) => {
    mockFetch(200, list);
    await expect(fetchNearIntentsTokens()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects a non-array body', async () => {
    mockFetch(200, { tokens: [] });
    await expect(fetchNearIntentsTokens()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('reports an unreachable API as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchNearIntentsTokens()).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('requestNearIntentsQuote', () => {
  it('sends an EXACT_OUTPUT request for DASH to the deposit address', async () => {
    const fetchMock = mockFetch(201, quoteResponse());
    await requestNearIntentsQuote(quoteParams(true));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${NEAR_INTENTS_API_URL}/v0/quote`);
    expect(JSON.parse(String(init!.body))).toMatchObject({
      dry: true,
      swapType: 'EXACT_OUTPUT',
      originAsset: USDC.assetId,
      destinationAsset: NEAR_INTENTS_DASH_ASSET_ID,
      amount: '5000000',
      recipient: RECIPIENT,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: REFUND,
      refundType: 'ORIGIN_CHAIN',
      depositType: 'ORIGIN_CHAIN',
      deadline: '2026-10-07T18:00:00.000Z',
    });
  });

  it('parses a confirmed quote including the deposit address', async () => {
    mockFetch(201, quoteResponse({ quote: { depositMemo: '12345' } }));
    const quote = await requestNearIntentsQuote(quoteParams(false));
    expect(quote).toEqual({
      originAssetId: USDC.assetId,
      amountIn: '2680000',
      minAmountIn: '2650000',
      amountOut: '5000000',
      amountInUsd: 2.68,
      amountOutUsd: 2.65,
      timeEstimateSec: 134,
      deadline: '2026-10-07T18:00:00.000Z',
      depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8',
      depositMemo: '12345',
      correlationId: '33a6afea-9d04-460d-add3-b2925e920218',
    });
  });

  it.each([
    ['in the past', '2026-10-07T16:00:00.000Z'],
    ['far in the future', '2027-01-01T00:00:00.000Z'],
    ['not a date', 'soon'],
  ])('falls back to the requested deadline when the reply\'s is %s', async (_case, deadline) => {
    mockFetch(201, quoteResponse({ quote: { deadline } }));
    await expect(requestNearIntentsQuote(quoteParams(false))).resolves.toMatchObject({ deadline: '2026-10-07T18:00:00.000Z' });
  });

  it('keeps an earlier server deadline', async () => {
    mockFetch(201, quoteResponse({ quote: { deadline: '2026-10-07T17:30:00.000Z' } }));
    await expect(requestNearIntentsQuote(quoteParams(false))).resolves.toMatchObject({ deadline: '2026-10-07T17:30:00.000Z' });
  });

  it('turns "No liquidity available" into a friendly message', async () => {
    mockFetch(400, { message: 'No liquidity available', correlationId: 'x' });
    const error = await requestNearIntentsQuote(quoteParams(true)).catch((e) => e);
    expect(error).toBeInstanceOf(NearIntentsError);
    expect(error.kind).toBe('no_liquidity');
    expect(error.message).toMatch(/can't route this asset to DASH right now/);
    expect(error.message).toMatch(/fund with DASH directly/);
  });

  it('passes other 4xx messages through, shortened', async () => {
    mockFetch(400, { message: `refundTo is not valid ${'x'.repeat(500)}` });
    const error = await requestNearIntentsQuote(quoteParams(true)).catch((e) => e);
    expect(error.kind).toBe('rejected');
    expect(error.message.startsWith('NEAR Intents rejected the request: refundTo is not valid')).toBe(true);
    expect(error.message.length).toBeLessThan(260);
  });

  it.each([
    ['recipient', { quoteRequest: { recipient: 'XattackerAddressxxxxxxxxxxxxxxxxxx' } }],
    ['destination asset', { quoteRequest: { destinationAsset: 'nep141:btc.omft.near' } }],
    ['origin asset', { quoteRequest: { originAsset: 'nep141:wrap.near' } }],
    ['amount', { quoteRequest: { amount: '1' } }],
    ['swap type', { quoteRequest: { swapType: 'EXACT_INPUT' } }],
    ['refund address', { quoteRequest: { refundTo: '0xdeadbeef00000000000000000000000000000000' } }],
    ['missing refund address', { quoteRequest: { refundTo: undefined } }],
    ['missing recipient type', { quoteRequest: { recipientType: undefined } }],
    ['refund type', { quoteRequest: { refundType: 'INTENTS' } }],
    ['deposit type', { quoteRequest: { depositType: 'INTENTS' } }],
  ])('refuses a quote whose %s differs from the request', async (_field, overrides) => {
    mockFetch(201, quoteResponse(overrides));
    await expect(requestNearIntentsQuote(quoteParams(false))).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('refuses a quote that would deliver less DASH than requested', async () => {
    mockFetch(201, quoteResponse({ quote: { minAmountOut: '4000000' } }));
    await expect(requestNearIntentsQuote(quoteParams(true))).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it.each([
    ['missing', undefined],
    ['markup', '"><img src=x onerror=alert(1)>'],
    ['whitespace', 'abc def ghi jkl'],
  ])('refuses a confirmed quote with a %s deposit address', async (_case, depositAddress) => {
    mockFetch(201, quoteResponse({ quote: { depositAddress } }));
    await expect(requestNearIntentsQuote(quoteParams(false))).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('refuses a memo containing markup', async () => {
    mockFetch(201, quoteResponse({ quote: { depositMemo: '<b>\n</b>' } }));
    await expect(requestNearIntentsQuote(quoteParams(false))).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects non-numeric amounts', async () => {
    mockFetch(201, quoteResponse({ quote: { amountIn: '1e9' } }));
    await expect(requestNearIntentsQuote(quoteParams(true))).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});

describe('getNearSwapStatus', () => {
  it('queries by deposit address and memo', async () => {
    const fetchMock = mockFetch(200, { status: 'PROCESSING', swapDetails: {} });
    await expect(getNearSwapStatus('0xabc12345', 'm1')).resolves.toBe('PROCESSING');
    expect(fetchMock.mock.calls[0][0]).toBe(`${NEAR_INTENTS_API_URL}/v0/status?depositAddress=0xabc12345&depositMemo=m1`);
  });

  it('treats an address the API does not know yet as pending', async () => {
    mockFetch(404, { message: 'Deposit address not found' });
    await expect(getNearSwapStatus('0xabc12345')).resolves.toBe('PENDING_DEPOSIT');
  });

  it('rejects an unknown status value', async () => {
    mockFetch(200, { status: '<img>' });
    await expect(getNearSwapStatus('0xabc12345')).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});

describe('helpers', () => {
  it('formats smallest units', () => {
    expect(formatUnits('2680000', 6)).toBe('2.68');
    expect(formatUnits('5', 8)).toBe('0.00000005');
    expect(formatUnits('100000000', 8)).toBe('1');
    expect(formatUnits('0', 6)).toBe('0');
    expect(formatUnits('42', 0)).toBe('42');
  });

  it('parses DASH amounts into duffs', () => {
    expect(parseDashToDuffs('0.05')).toBe(5_000_000);
    expect(parseDashToDuffs(' 1 ')).toBe(100_000_000);
    expect(parseDashToDuffs('1.')).toBe(100_000_000);
    expect(parseDashToDuffs('0.000000001')).toBeNull();
    expect(parseDashToDuffs('-1')).toBeNull();
    expect(parseDashToDuffs('abc')).toBeNull();
    expect(parseDashToDuffs('')).toBeNull();
    expect(parseDashToDuffs('21000000')).toBe(2_100_000_000_000_000);
    expect(parseDashToDuffs('99999999.99999999')).toBeNull();
  });

  it('treats an unfunded swap past its deadline as expired', () => {
    const deadline = '2026-10-07T18:00:00.000Z';
    const after = Date.parse(deadline) + 1;
    expect(isNearSwapExpired({ status: 'PENDING_DEPOSIT', deadline }, after)).toBe(true);
    expect(isNearSwapExpired({ status: 'PENDING_DEPOSIT', deadline }, NOW)).toBe(false);
    expect(isNearSwapExpired({ status: 'PROCESSING', deadline }, after)).toBe(false);
  });

  it('checks refund addresses loosely', () => {
    expect(validateRefundAddress(REFUND)).toBeUndefined();
    expect(validateRefundAddress('  ')).toMatch(/Enter an address/);
    expect(validateRefundAddress('has space')).toMatch(/valid address/);
  });

  it('builds the NEAR Intents app link', () => {
    expect(nearIntentsAppUrl(USDC)).toBe('https://near-intents.org/?from=USDC:eth&to=DASH');
    expect(nearIntentsAppUrl()).toBe('https://near-intents.org/?to=DASH');
  });
});

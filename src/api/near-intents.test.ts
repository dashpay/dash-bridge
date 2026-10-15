import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NEAR_INTENTS_API_URL,
  NEAR_INTENTS_DASH_ASSET_ID,
  NearIntentsError,
  fetchNearIntentsTokens,
  formatUnits,
  getNearSwapStatus,
  formatUnitsShort,
  isNearOutputDropTooLarge,
  isNearPriceIncreaseTooLarge,
  isNearSwapExpired,
  isSameNearAsset,
  NEAR_DRY_QUOTE_REFUND_ACCOUNT,
  nearIntentsAppUrl,
  nearSwapPaymentCutoff,
  nearSwapWindowMs,
  parseUnits,
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
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

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
      slippageTolerance: 100,
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

const QUOTE_BASE = {
  originAsset: USDC,
  swapType: 'EXACT_OUTPUT' as const,
  amount: '5000000',
  minAmountOutDuffs: 300_000,
  recipient: RECIPIENT,
  now: NOW,
};
const quoteParams = (dry: boolean) => (dry
  ? { ...QUOTE_BASE, dry: true as const }
  : { ...QUOTE_BASE, dry: false as const, refundTo: REFUND });
/** What 1Click echoes for a dry quote: our placeholder refund target. */
const DRY_ECHO = { refundTo: NEAR_DRY_QUOTE_REFUND_ACCOUNT, refundType: 'INTENTS' };
/** A pay-side (EXACT_INPUT) quote for 20 USDC. */
const exactInput = { ...QUOTE_BASE, swapType: 'EXACT_INPUT' as const, amount: '20000000', dry: false as const, refundTo: REFUND };
const exactInputResponse = (quote: Record<string, unknown> = {}) => quoteResponse({
  quote: { amountIn: '20000000', minAmountIn: '20000000', amountOut: '39400815', minAmountOut: '39006806', ...quote },
  quoteRequest: { swapType: 'EXACT_INPUT', amount: '20000000' },
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
  it('prices a dry quote with a placeholder refund target, not the user\'s address', async () => {
    const fetchMock = mockFetch(201, quoteResponse({ quoteRequest: DRY_ECHO }));
    await requestNearIntentsQuote(quoteParams(true));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toMatchObject({
      dry: true,
      refundTo: NEAR_DRY_QUOTE_REFUND_ACCOUNT,
      refundType: 'INTENTS',
    });
  });

  it('refuses a dry quote that echoes the user refund target instead of the placeholder', async () => {
    mockFetch(201, quoteResponse());
    await expect(requestNearIntentsQuote(quoteParams(true))).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('sends an EXACT_OUTPUT request for DASH to the deposit address', async () => {
    const fetchMock = mockFetch(201, quoteResponse());
    await requestNearIntentsQuote(quoteParams(false));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${NEAR_INTENTS_API_URL}/v0/quote`);
    expect(JSON.parse(String(init!.body))).toMatchObject({
      dry: false,
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
      minAmountOut: '5000000',
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

  it('asks for a 3 hour deadline when paying from a slow chain', async () => {
    const fetchMock = mockFetch(201, quoteResponse({ quoteRequest: { originAsset: 'nep141:btc.omft.near' } }));
    const btc = { assetId: 'nep141:btc.omft.near', symbol: 'BTC', blockchain: 'btc', decimals: 8 };
    await requestNearIntentsQuote({ ...quoteParams(false), originAsset: btc });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body)).deadline).toBe('2026-10-07T20:00:00.000Z');
  });

  it.each([['2.68'], ['2.680000'], ['02.68']])('accepts amountInFormatted %s matching the decimals', async (formatted) => {
    mockFetch(201, quoteResponse({ quote: { amountInFormatted: formatted } }));
    await expect(requestNearIntentsQuote(quoteParams(false))).resolves.toMatchObject({ amountIn: '2680000' });
  });

  it.each([['0.00000268'], ['2680000'], ['2.68 USDC'], [2.68]])(
    'refuses a quote whose amountInFormatted %s disagrees with the decimals',
    async (formatted) => {
      mockFetch(201, quoteResponse({ quote: { amountInFormatted: formatted } }));
      await expect(requestNearIntentsQuote(quoteParams(false))).rejects.toMatchObject({ kind: 'invalid_response' });
    }
  );

  it('refuses a minimum input above the quoted input', async () => {
    mockFetch(201, quoteResponse({ quote: { minAmountIn: '2680001' } }));
    await expect(requestNearIntentsQuote(quoteParams(false))).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('turns "No liquidity available" into a friendly message', async () => {
    mockFetch(400, { message: 'No liquidity available', correlationId: 'x' });
    const error = await requestNearIntentsQuote(quoteParams(false)).catch((e) => e);
    expect(error).toBeInstanceOf(NearIntentsError);
    expect(error.kind).toBe('no_liquidity');
    expect(error.message).toMatch(/can't route this asset to DASH right now/);
    expect(error.message).toMatch(/fund with DASH directly/);
  });

  it('passes other 4xx messages through, shortened', async () => {
    mockFetch(400, { message: `refundTo is not valid ${'x'.repeat(500)}` });
    const error = await requestNearIntentsQuote(quoteParams(false)).catch((e) => e);
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
    ['slippage', { quoteRequest: { slippageTolerance: 9000 } }],
    ['missing slippage', { quoteRequest: { slippageTolerance: undefined } }],
    ['refund address', { quoteRequest: { refundTo: '0xdeadbeef00000000000000000000000000000000' } }],
    ['missing refund address', { quoteRequest: { refundTo: undefined } }],
    ['missing recipient type', { quoteRequest: { recipientType: undefined } }],
    ['refund type', { quoteRequest: { refundType: 'INTENTS' } }],
    ['deposit type', { quoteRequest: { depositType: 'INTENTS' } }],
  ])('refuses a quote whose %s differs from the request', async (_field, overrides) => {
    mockFetch(201, quoteResponse(overrides));
    await expect(requestNearIntentsQuote(quoteParams(false))).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('accepts BTC echoed in the newer native-coin id scheme', async () => {
    const btc = { assetId: 'nep141:btc.omft.near', symbol: 'BTC', blockchain: 'btc', decimals: 8 };
    mockFetch(201, quoteResponse({ quoteRequest: { originAsset: '1cs_v1:btc:native:coin' } }));
    await expect(requestNearIntentsQuote({ ...quoteParams(false), originAsset: btc })).resolves.toMatchObject({ amountOut: '5000000' });
  });

  it('matches native-coin ids only to the same chain\'s coin', () => {
    expect(isSameNearAsset('nep141:btc.omft.near', '1cs_v1:btc:native:coin')).toBe(true);
    expect(isSameNearAsset('nep141:btc.omft.near', '1cs_v1:ltc:native:coin')).toBe(false);
    expect(isSameNearAsset(USDC.assetId, '1cs_v1:eth:native:coin')).toBe(false);
    expect(isSameNearAsset('nep141:btc.omft.near', undefined)).toBe(false);
  });

  it('sends a pay-side amount as EXACT_INPUT and keeps the guaranteed minimum', async () => {
    const fetchMock = mockFetch(201, exactInputResponse());
    const quote = await requestNearIntentsQuote(exactInput);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).toMatchObject({ swapType: 'EXACT_INPUT', amount: '20000000' });
    expect(quote).toMatchObject({ amountIn: '20000000', amountOut: '39400815', minAmountOut: '39006806' });
  });

  it.each([
    ['prices a different input', { amountIn: '19000000' }],
    ['gives no minimum output', { minAmountOut: undefined }],
    ['has a minimum above the estimate', { minAmountOut: '39400816' }],
    ['has a minimum far below the estimate', { minAmountOut: '310000' }],
  ])('refuses an EXACT_INPUT quote that %s', async (_case, quote) => {
    mockFetch(201, exactInputResponse(quote));
    await expect(requestNearIntentsQuote(exactInput)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('refuses an EXACT_INPUT quote that may deliver less than the deposit needs', async () => {
    mockFetch(201, exactInputResponse());
    const error = await requestNearIntentsQuote({ ...exactInput, minAmountOutDuffs: 40_000_000 }).catch((e) => e);
    expect(error.kind).toBe('too_low');
    expect(error.message).toMatch(/less than the 0.4 DASH this deposit needs/);
  });

  it.each([
    ['EXACT_OUTPUT', quoteParams(false), '10392075', '0.10392075 DASH'],
    ['EXACT_INPUT', exactInput, '564367', '0.564367 USDC'],
  ])('reports the minimum of a too-small %s amount in the typed asset', async (_type, params, min, text) => {
    mockFetch(400, { message: `Amount is too low for bridge, try at least ${min}` });
    const error = await requestNearIntentsQuote(params).catch((e) => e);
    expect(error).toMatchObject({ kind: 'too_low', minAmount: min });
    expect(error.message).toContain(`The minimum is ${text}.`);
  });

  it('refuses to request a zero amount', async () => {
    const fetchMock = mockFetch(201, quoteResponse());
    await expect(requestNearIntentsQuote({ ...quoteParams(false), amount: '0' })).rejects.toBeInstanceOf(NearIntentsError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a quote that would deliver less DASH than requested', async () => {
    mockFetch(201, quoteResponse({ quote: { minAmountOut: '4000000' } }));
    await expect(requestNearIntentsQuote(quoteParams(false))).rejects.toMatchObject({ kind: 'invalid_response' });
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
    await expect(requestNearIntentsQuote(quoteParams(false))).rejects.toMatchObject({ kind: 'invalid_response' });
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

  it('parses typed amounts into smallest units', () => {
    expect(parseUnits('0.05', 8)).toBe('5000000');
    expect(parseUnits(' 1 ', 8)).toBe('100000000');
    expect(parseUnits('1.', 8)).toBe('100000000');
    expect(parseUnits('.5', 6)).toBe('500000');
    expect(parseUnits('20', 6)).toBe('20000000');
    expect(parseUnits('1.5', 18)).toBe('1500000000000000000');
    expect(parseUnits('42', 0)).toBe('42');
    expect(parseUnits('0.000000001', 8)).toBeNull();
    expect(parseUnits('1.5', 0)).toBeNull();
    expect(parseUnits('-1', 8)).toBeNull();
    expect(parseUnits('1e3', 8)).toBeNull();
    expect(parseUnits('abc', 8)).toBeNull();
    expect(parseUnits('.', 8)).toBeNull();
    expect(parseUnits('', 8)).toBeNull();
  });

  it('shortens amounts for display, rounding payments up', () => {
    expect(formatUnitsShort('39400815', 8)).toBe('0.394008');
    expect(formatUnitsShort('39400815', 8, 6, true)).toBe('0.394009');
    expect(formatUnitsShort('2680000', 6)).toBe('2.68');
    expect(formatUnitsShort('1234567890123456789', 18, 6, true)).toBe('1.234568');
  });

  it('gives slow source chains a longer payment window', () => {
    expect(nearSwapWindowMs('eth')).toBe(60 * MINUTE);
    for (const chain of ['btc', 'ltc', 'doge', 'zec', 'bch']) expect(nearSwapWindowMs(chain)).toBe(180 * MINUTE);
  });

  it('cuts payment off a margin before the deadline: max(10 min, 1/4 of the window)', () => {
    const deadline = '2026-10-07T18:00:00.000Z';
    const at = Date.parse(deadline);
    expect(nearSwapPaymentCutoff({ deadline, blockchain: 'eth' })).toBe(at - 15 * MINUTE);
    expect(nearSwapPaymentCutoff({ deadline, blockchain: 'btc' })).toBe(at - 45 * MINUTE);
  });

  it('treats a swap still awaiting payment past the cutoff as expired', () => {
    const deadline = '2026-10-07T18:00:00.000Z';
    const cutoff = Date.parse(deadline) - 15 * MINUTE;
    const swap = { deadline, blockchain: 'eth' };
    expect(isNearSwapExpired({ ...swap, status: 'PENDING_DEPOSIT' }, cutoff - 1)).toBe(false);
    expect(isNearSwapExpired({ ...swap, status: 'PENDING_DEPOSIT' }, cutoff)).toBe(true);
    expect(isNearSwapExpired({ ...swap, status: 'INCOMPLETE_DEPOSIT' }, cutoff)).toBe(true);
    expect(isNearSwapExpired({ ...swap, status: 'INCOMPLETE_DEPOSIT' }, cutoff - 1)).toBe(false);
    expect(isNearSwapExpired({ ...swap, status: 'PROCESSING' }, cutoff + HOUR)).toBe(false);
    expect(isNearSwapExpired({ ...swap, status: 'PENDING_DEPOSIT', deadline: 'garbage' }, NOW)).toBe(true);
  });

  it('flags a confirmed quote more than the allowed basis points above the approved one', () => {
    expect(isNearPriceIncreaseTooLarge('1000000', '1020000', 200n)).toBe(false);
    expect(isNearPriceIncreaseTooLarge('1000000', '1020001', 200n)).toBe(true);
    expect(isNearPriceIncreaseTooLarge('1000000', '900000', 200n)).toBe(false);
    expect(isNearPriceIncreaseTooLarge('1', '2', 200n)).toBe(true);
  });

  it('flags a confirmed quote delivering more than the allowed basis points less DASH', () => {
    expect(isNearOutputDropTooLarge('1000000', '980000', 200n)).toBe(false);
    expect(isNearOutputDropTooLarge('1000000', '979999', 200n)).toBe(true);
    expect(isNearOutputDropTooLarge('1000000', '1100000', 200n)).toBe(false);
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

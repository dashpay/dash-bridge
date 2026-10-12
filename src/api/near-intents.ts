/**
 * NEAR Intents 1Click API client.
 *
 * Lets a user fund the bridge's Dash deposit address from another asset: the
 * 1Click service quotes a swap into DASH, hands out a deposit address on the
 * origin chain, and its solvers deliver DASH to our recipient address. The
 * bridge's own UTXO polling then picks the DASH up like any other deposit.
 *
 * The API is called unauthenticated straight from the browser (it allows
 * CORS). Everything it returns is treated as untrusted: values are type- and
 * shape-checked here, and a quote is only accepted when it echoes back our
 * recipient, DASH as the destination and the exact amount we asked for.
 */

import { fetchWithDeadline, RequestTimeoutError } from '../utils/fetch-with-deadline.js';

export const NEAR_INTENTS_API_URL = 'https://1click.chaindefuser.com';
/** NEAR Intents' bridged DASH (delivered on the Dash chain). */
export const NEAR_INTENTS_DASH_ASSET_ID = 'nep141:dash.omft.near';
export const NEAR_INTENTS_APP_URL = 'https://near-intents.org/';
/** How long the user has to send funds before an unfunded swap is refunded. */
export const NEAR_SWAP_DEADLINE_MS = 60 * 60 * 1000;
/** Slippage tolerance in basis points (1%). */
const SLIPPAGE_BPS = 100;
/** Rounding allowance when checking a quote's floor against its slippage, in basis points. */
const SLIPPAGE_ROUNDING_BPS = 10;
const REQUEST_TIMEOUT_MS = 20_000;

export interface NearIntentsToken {
  assetId: string;
  symbol: string;
  /** 1Click chain id, e.g. `eth`, `sol`, `btc`. */
  blockchain: string;
  decimals: number;
  priceUsd?: number;
}

export const NEAR_SWAP_STATUSES = [
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'PROCESSING',
  'SUCCESS',
  'INCOMPLETE_DEPOSIT',
  'REFUNDED',
  'FAILED',
] as const;
export type NearSwapStatus = (typeof NEAR_SWAP_STATUSES)[number];

/**
 * Source chains whose payments can take about an hour to confirm. The 1Click
 * deadline must outlast confirmation, so they get a longer window.
 */
const SLOW_CHAINS = new Set(['btc', 'ltc', 'doge', 'zec', 'bch']);
const SLOW_CHAIN_SWAP_WINDOW_MS = 3 * 60 * 60 * 1000;
const MIN_PAYMENT_MARGIN_MS = 10 * 60 * 1000;

/** How long the user has to pay before 1Click refunds an unfunded swap. */
export function nearSwapWindowMs(blockchain: string): number {
  return SLOW_CHAINS.has(blockchain) ? SLOW_CHAIN_SWAP_WINDOW_MS : NEAR_SWAP_DEADLINE_MS;
}

/**
 * Last moment we tell the user to send: well before the 1Click deadline, so a
 * payment still confirms in time. Margin is max(10 min, 1/4 of the window).
 */
export function nearSwapPaymentCutoff(swap: { deadline: string; blockchain: string }): number {
  const window = nearSwapWindowMs(swap.blockchain);
  return Date.parse(swap.deadline) - Math.max(MIN_PAYMENT_MARGIN_MS, window / 4);
}

/**
 * A swap still awaiting (all of) its payment, past the payment cutoff: its
 * payment address must no longer be shown. An unparseable deadline counts.
 */
export function isNearSwapExpired(
  swap: { status: NearSwapStatus; deadline: string; blockchain: string },
  now = Date.now()
): boolean {
  const awaitingPayment = swap.status === 'PENDING_DEPOSIT' || swap.status === 'INCOMPLETE_DEPOSIT';
  return awaitingPayment && !(nearSwapPaymentCutoff(swap) > now);
}

/**
 * Whether a confirmed quote costs more than `maxIncreaseBps` above the one
 * the user approved (amounts in the origin asset's smallest units).
 */
export function isNearPriceIncreaseTooLarge(approvedAmountIn: string, amountIn: string, maxIncreaseBps: bigint): boolean {
  return BigInt(amountIn) * 10_000n > BigInt(approvedAmountIn) * (10_000n + maxIncreaseBps);
}

/**
 * Whether a confirmed quote delivers more than `maxDecreaseBps` less DASH
 * than the one the user approved (amounts in duffs).
 */
export function isNearOutputDropTooLarge(approvedAmountOut: string, amountOut: string, maxDecreaseBps: bigint): boolean {
  return BigInt(amountOut) * 10_000n < BigInt(approvedAmountOut) * (10_000n - maxDecreaseBps);
}

/**
 * `EXACT_INPUT`: the user names what they pay and DASH out is quoted.
 * `EXACT_OUTPUT`: the user names the DASH to deliver and the payment is quoted.
 */
export type NearSwapType = 'EXACT_INPUT' | 'EXACT_OUTPUT';

/**
 * Refund target for dry quotes. Pricing needs a refund address, but a dry
 * quote never takes funds, so a chain-agnostic Intents account stands in until
 * the user enters their own address for the real quote.
 */
export const NEAR_DRY_QUOTE_REFUND_ACCOUNT = 'intents.near';

interface NearQuoteRequestBase {
  originAsset: NearIntentsToken;
  swapType: NearSwapType;
  /**
   * Integer amount in smallest units: the origin asset to send
   * (`EXACT_INPUT`) or the DASH to deliver, in duffs (`EXACT_OUTPUT`).
   */
  amount: string;
  /** Least DASH the deposit must receive, in duffs; a quote that may deliver less is rejected. */
  minAmountOutDuffs: number;
  /** Bridge deposit address that receives the DASH. */
  recipient: string;
  /** Defaults to now. */
  now?: number;
}

/** Dry quotes only price the swap; a real quote opens a deposit address and needs the user's refund address. */
export type NearQuoteRequest =
  | (NearQuoteRequestBase & { dry: true })
  | (NearQuoteRequestBase & { dry: false; refundTo: string });

export interface NearIntentsQuote {
  originAssetId: string;
  /** Amount to send, in the origin asset's smallest units. */
  amountIn: string;
  /** Smallest deposit the swap still accepts, if the API gave one. */
  minAmountIn?: string;
  /** DASH delivered, in duffs. */
  amountOut: string;
  /** Least DASH delivered after slippage, in duffs, if the API gave it. */
  minAmountOut?: string;
  amountInUsd?: number;
  amountOutUsd?: number;
  /** Estimated completion time after the deposit, in seconds. */
  timeEstimateSec?: number;
  /** ISO time after which an unfunded swap is refunded. */
  deadline: string;
  /** Present on real (non-dry) quotes. */
  depositAddress?: string;
  depositMemo?: string;
  correlationId?: string;
}

export type NearIntentsErrorKind = 'no_liquidity' | 'too_low' | 'rejected' | 'unavailable' | 'invalid_response';

export class NearIntentsError extends Error {
  constructor(
    public readonly kind: NearIntentsErrorKind,
    message: string,
    /** `too_low`: the smallest accepted `amount`, in the request's smallest units. */
    public readonly minAmount?: string
  ) {
    super(message);
    this.name = 'NearIntentsError';
  }
}

const MAX_API_MESSAGE_LENGTH = 200;
const ASSET_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const CHAIN_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const UNSIGNED_INT_PATTERN = /^\d{1,78}$/;
/** Deposit addresses across supported chains: base58, hex, bech32, base64url, NEAR accounts. */
const DEPOSIT_ADDRESS_PATTERN = /^[A-Za-z0-9._:+/=-]{8,128}$/;
/** Printable ASCII, no leading/trailing space. */
const MEMO_PATTERN = /^[\x21-\x7e]([\x20-\x7e]{0,126}[\x21-\x7e])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function unsignedIntString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UNSIGNED_INT_PATTERN.test(value)) {
    throw new NearIntentsError('invalid_response', `NEAR Intents returned an invalid ${field}.`);
  }
  return value;
}

/** Keep server-provided messages short and single-line; they are still escaped on render. */
function cleanApiMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  return oneLine.length > MAX_API_MESSAGE_LENGTH ? `${oneLine.slice(0, MAX_API_MESSAGE_LENGTH)}…` : oneLine;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError';
}

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  try {
    return await fetchWithDeadline(`${NEAR_INTENTS_API_URL}${path}`, init, REQUEST_TIMEOUT_MS, async (response) => ({
      status: response.status,
      body: await response.json().catch((error: unknown) => {
        // A deadline or caller abort mid-body is not a malformed reply.
        if (isAbortError(error)) throw error;
        return undefined;
      }),
    }));
  } catch (error) {
    if (isAbortError(error)) throw error;
    const reason = error instanceof RequestTimeoutError ? 'timed out' : 'could not be reached';
    throw new NearIntentsError('unavailable', `NEAR Intents ${reason}. Check your connection and try again.`);
  }
}

function errorFromResponse(status: number, body: unknown): NearIntentsError {
  const message = isRecord(body) ? cleanApiMessage(body.message) : undefined;
  if (message && /no liquidity|no quotes?\b|not enough liquidity/i.test(message)) {
    return new NearIntentsError(
      'no_liquidity',
      "NEAR Intents can't route this asset to DASH right now. Try again later or pick another asset, or fund with DASH directly."
    );
  }
  const tooLow = message ? /too low.*?at least (\d{1,78})\b/i.exec(message) : null;
  if (status >= 400 && status < 500 && tooLow) {
    return new NearIntentsError('too_low', 'That amount is too small for NEAR Intents.', tooLow[1]);
  }
  if (status >= 400 && status < 500 && status !== 429 && message) {
    return new NearIntentsError('rejected', `NEAR Intents rejected the request: ${message}`);
  }
  if (status === 429) {
    return new NearIntentsError('unavailable', 'NEAR Intents is rate limiting requests. Wait a minute and try again.');
  }
  return new NearIntentsError('unavailable', `NEAR Intents is unavailable right now (HTTP ${status}). Try again later.`);
}

function parseToken(value: unknown): NearIntentsToken | null {
  if (!isRecord(value)) return null;
  const { assetId, symbol, blockchain, decimals } = value;
  if (typeof assetId !== 'string' || !ASSET_ID_PATTERN.test(assetId)) return null;
  if (typeof symbol !== 'string' || symbol.trim() === '' || symbol.length > 32) return null;
  if (typeof blockchain !== 'string' || !CHAIN_PATTERN.test(blockchain)) return null;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
  const priceUsd = optionalNumber(value.price);
  return { assetId, symbol: symbol.trim(), blockchain, decimals, ...(priceUsd !== undefined ? { priceUsd } : {}) };
}

/** Assets NEAR Intents supports. Malformed entries are dropped. */
export async function fetchNearIntentsTokens(signal?: AbortSignal): Promise<NearIntentsToken[]> {
  const { status, body } = await request('/v0/tokens', { signal });
  if (status < 200 || status >= 300) throw errorFromResponse(status, body);
  if (!Array.isArray(body)) {
    throw new NearIntentsError('invalid_response', 'NEAR Intents returned an invalid token list.');
  }
  const seen = new Set<string>();
  const tokens: NearIntentsToken[] = [];
  for (const entry of body) {
    const token = parseToken(entry);
    if (token && !seen.has(token.assetId)) {
      seen.add(token.assetId);
      tokens.push(token);
    }
  }
  // Quote amounts are sent in duffs; a DASH listing with other decimals would
  // deliver a wildly different amount than the user asked for.
  const dash = tokens.find((t) => t.assetId === NEAR_INTENTS_DASH_ASSET_ID);
  if (!dash || dash.decimals !== 8) {
    throw new NearIntentsError('invalid_response', 'NEAR Intents does not currently list DASH as expected, so it cannot be used here.');
  }
  if (selectableSourceTokens(tokens).length === 0) {
    throw new NearIntentsError('invalid_response', 'NEAR Intents returned no usable assets.');
  }
  return tokens;
}

/** Tokens a user can pay with: everything except DASH itself. */
export function selectableSourceTokens(tokens: NearIntentsToken[]): NearIntentsToken[] {
  return tokens.filter((t) => t.assetId !== NEAR_INTENTS_DASH_ASSET_ID && t.blockchain !== 'dash');
}

/**
 * Whether `echoed` names the asset we asked for. 1Click echoes some native
 * coins in its newer id scheme (`nep141:btc.omft.near` comes back as
 * `1cs_v1:btc:native:coin`); both name the same chain's native coin.
 */
export function isSameNearAsset(requested: string, echoed: unknown): boolean {
  if (echoed === requested) return true;
  const native = /^nep141:([a-z0-9]+)\.omft\.near$/.exec(requested);
  return native !== null && echoed === `1cs_v1:${native[1]}:native:coin`;
}

/**
 * The server's deadline, if it is a sane time between now and the deadline
 * we asked for; otherwise ours.
 */
function isoDeadline(value: unknown, now: number, requested: string): string {
  const ms = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return ms > now && ms <= Date.parse(requested) ? new Date(ms).toISOString() : requested;
}

/**
 * Request a swap quote that delivers DASH to `recipient`. Rejects any reply
 * that doesn't echo back our recipient, DASH as the destination, the origin
 * asset, swap type, amount and refund target, since showing its deposit
 * address would then send the user's funds somewhere else. A quote that may
 * deliver less than `minAmountOutDuffs` is rejected too.
 */
export async function requestNearIntentsQuote(
  params: NearQuoteRequest,
  signal?: AbortSignal
): Promise<NearIntentsQuote> {
  const now = params.now ?? Date.now();
  const deadline = new Date(now + nearSwapWindowMs(params.originAsset.blockchain)).toISOString();
  const { swapType, amount } = params;
  if (!UNSIGNED_INT_PATTERN.test(amount) || BigInt(amount) === 0n) {
    throw new NearIntentsError('rejected', 'Enter an amount greater than zero.');
  }
  const refund = params.dry
    ? { refundTo: NEAR_DRY_QUOTE_REFUND_ACCOUNT, refundType: 'INTENTS' }
    : { refundTo: params.refundTo, refundType: 'ORIGIN_CHAIN' };
  const payload = {
    dry: params.dry,
    swapType,
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: params.originAsset.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: NEAR_INTENTS_DASH_ASSET_ID,
    amount,
    ...refund,
    recipient: params.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline,
    referral: 'dash-bridge',
  };

  const { status, body } = await request('/v0/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (status < 200 || status >= 300) {
    const error = errorFromResponse(status, body);
    if (error.kind === 'too_low' && error.minAmount !== undefined) {
      const [decimals, symbol] = swapType === 'EXACT_INPUT' ? [params.originAsset.decimals, params.originAsset.symbol] : [8, 'DASH'];
      throw new NearIntentsError('too_low', `That amount is too small to swap. The minimum is ${formatUnits(error.minAmount, decimals)} ${symbol}.`, error.minAmount);
    }
    throw error;
  }
  if (!isRecord(body) || !isRecord(body.quote) || !isRecord(body.quoteRequest)) {
    throw new NearIntentsError('invalid_response', 'NEAR Intents returned an invalid quote.');
  }

  const echoed = body.quoteRequest;
  if (
    echoed.recipient !== params.recipient ||
    echoed.destinationAsset !== NEAR_INTENTS_DASH_ASSET_ID ||
    !isSameNearAsset(params.originAsset.assetId, echoed.originAsset) ||
    echoed.swapType !== swapType ||
    echoed.slippageTolerance !== SLIPPAGE_BPS ||
    echoed.amount !== amount ||
    echoed.recipientType !== 'DESTINATION_CHAIN' ||
    echoed.refundTo !== refund.refundTo ||
    echoed.refundType !== refund.refundType ||
    echoed.depositType !== 'ORIGIN_CHAIN'
  ) {
    throw new NearIntentsError(
      'invalid_response',
      'NEAR Intents returned a quote that does not match this deposit (recipient, asset or amount differ). It was not used.'
    );
  }

  const q = body.quote;
  const amountIn = unsignedIntString(q.amountIn, 'input amount');
  const amountOut = unsignedIntString(q.amountOut, 'output amount');
  const minAmountOut = q.minAmountOut !== undefined ? unsignedIntString(q.minAmountOut, 'minimum output') : undefined;
  if (BigInt(amountIn) === 0n) {
    throw new NearIntentsError('invalid_response', 'NEAR Intents returned an invalid input amount.');
  }
  if (swapType === 'EXACT_OUTPUT') {
    if (BigInt(amountOut) < BigInt(amount)) {
      throw new NearIntentsError('invalid_response', 'NEAR Intents returned a quote for less DASH than requested.');
    }
    if (minAmountOut !== undefined && BigInt(minAmountOut) < BigInt(amount)) {
      throw new NearIntentsError('invalid_response', 'NEAR Intents could deliver less DASH than requested; the quote was not used.');
    }
  } else {
    // We tell the user to send `amount`; a quote priced for another input is not for this payment.
    if (amountIn !== amount) {
      throw new NearIntentsError('invalid_response', 'NEAR Intents returned a quote for a different amount; it was not used.');
    }
    // Without a floor, a bad fill could deliver less than the bridge needs;
    // a floor further below the estimate than our slippage isn't the quote we priced.
    if (
      minAmountOut === undefined ||
      BigInt(minAmountOut) > BigInt(amountOut) ||
      BigInt(minAmountOut) * 10_000n < BigInt(amountOut) * BigInt(10_000 - SLIPPAGE_BPS - SLIPPAGE_ROUNDING_BPS)
    ) {
      throw new NearIntentsError('invalid_response', 'NEAR Intents did not guarantee a minimum DASH amount; the quote was not used.');
    }
  }
  const neededOut = String(Math.trunc(params.minAmountOutDuffs));
  if (BigInt(minAmountOut ?? amountOut) < BigInt(neededOut)) {
    throw new NearIntentsError('too_low', `You would receive less than the ${formatUnits(neededOut, 8)} DASH this deposit needs. Pay a little more.`);
  }
  const minAmountIn = q.minAmountIn !== undefined ? unsignedIntString(q.minAmountIn, 'minimum input') : undefined;
  if (minAmountIn !== undefined && BigInt(minAmountIn) > BigInt(amountIn)) {
    throw new NearIntentsError('invalid_response', 'NEAR Intents returned an inconsistent quote.');
  }
  // The API formats amounts with its own decimals. If they disagree with the
  // token list's, our "send exactly" amount would be off by orders of magnitude.
  if (
    q.amountInFormatted !== undefined &&
    normalizeDecimal(q.amountInFormatted) !== formatUnits(amountIn, params.originAsset.decimals)
  ) {
    throw new NearIntentsError('invalid_response', 'NEAR Intents returned amounts that do not match the asset\'s decimals; the quote was not used.');
  }

  const quote: NearIntentsQuote = {
    originAssetId: params.originAsset.assetId,
    amountIn,
    amountOut,
    deadline: isoDeadline(q.deadline, now, deadline),
  };
  if (minAmountIn !== undefined) quote.minAmountIn = minAmountIn;
  if (minAmountOut !== undefined) quote.minAmountOut = minAmountOut;
  const amountInUsd = optionalNumber(q.amountInUsd);
  const amountOutUsd = optionalNumber(q.amountOutUsd);
  const timeEstimateSec = optionalNumber(q.timeEstimate);
  if (amountInUsd !== undefined) quote.amountInUsd = amountInUsd;
  if (amountOutUsd !== undefined) quote.amountOutUsd = amountOutUsd;
  if (timeEstimateSec !== undefined && timeEstimateSec >= 0) quote.timeEstimateSec = timeEstimateSec;
  if (typeof body.correlationId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(body.correlationId)) {
    quote.correlationId = body.correlationId;
  }

  if (!params.dry) {
    if (typeof q.depositAddress !== 'string' || !DEPOSIT_ADDRESS_PATTERN.test(q.depositAddress)) {
      throw new NearIntentsError('invalid_response', 'NEAR Intents did not return a valid deposit address.');
    }
    quote.depositAddress = q.depositAddress;
    if (q.depositMemo !== undefined && q.depositMemo !== null && q.depositMemo !== '') {
      if (typeof q.depositMemo !== 'string' || !MEMO_PATTERN.test(q.depositMemo)) {
        throw new NearIntentsError('invalid_response', 'NEAR Intents returned an invalid deposit memo.');
      }
      quote.depositMemo = q.depositMemo;
    }
  }
  return quote;
}

/**
 * Current status of a swap. An address the API doesn't know yet (404) is
 * reported as PENDING_DEPOSIT, since it was just handed out.
 */
export async function getNearSwapStatus(
  depositAddress: string,
  depositMemo?: string,
  signal?: AbortSignal
): Promise<NearSwapStatus> {
  const query = new URLSearchParams({ depositAddress });
  if (depositMemo) query.set('depositMemo', depositMemo);
  const { status, body } = await request(`/v0/status?${query}`, { signal });
  if (status === 404) return 'PENDING_DEPOSIT';
  if (status < 200 || status >= 300) throw errorFromResponse(status, body);
  const value = isRecord(body) ? body.status : undefined;
  if (typeof value !== 'string' || !(NEAR_SWAP_STATUSES as readonly string[]).includes(value)) {
    throw new NearIntentsError('invalid_response', 'NEAR Intents returned an unknown swap status.');
  }
  return value as NearSwapStatus;
}

/** Format an integer amount in smallest units as a decimal string, trimming trailing zeros. */
export function formatUnits(amount: string, decimals: number): string {
  const digits = amount.replace(/^0+(?=\d)/, '');
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Canonical form of a plain decimal string ("01.50" → "1.5"), or undefined if it isn't one. */
function normalizeDecimal(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{1,78})(?:\.(\d{1,78}))?$/.exec(value);
  if (!match) return undefined;
  const whole = match[1].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Parse a user-entered amount of an asset with `decimals` places into an
 * integer string of its smallest units, or null if it isn't a plain decimal
 * with at most that many places. ("1." and ".5" are accepted.)
 */
export function parseUnits(input: string, decimals: number): string | null {
  const match = /^(\d{0,30})(?:\.(\d*))?$/.exec(input.trim());
  if (!match || (match[1] === '' && !match[2]) || (match[2] ?? '').length > decimals) return null;
  const units = BigInt(match[1] || '0') * 10n ** BigInt(decimals) + BigInt((match[2] ?? '').padEnd(decimals, '0') || '0');
  return units.toString();
}

/**
 * A smallest-units amount for display: at most `maxFraction` decimals,
 * rounded up when `roundUp` (amounts the user must pay never look smaller).
 */
export function formatUnitsShort(amount: string, decimals: number, maxFraction = 6, roundUp = false): string {
  if (decimals <= maxFraction) return formatUnits(amount, decimals);
  const step = 10n ** BigInt(decimals - maxFraction);
  const value = BigInt(amount);
  const rounded = roundUp ? ((value + step - 1n) / step) * step : (value / step) * step;
  return formatUnits(rounded.toString(), decimals);
}

/** Basic shape check for a refund address; the API validates it per chain. */
export function validateRefundAddress(input: string): string | undefined {
  const value = input.trim();
  if (!value) return 'Enter an address on the source chain for refunds.';
  if (value.length > 128 || !/^[\x21-\x7e]+$/.test(value)) return 'That does not look like a valid address.';
  return undefined;
}

/**
 * Link to the NEAR Intents web app with the pair preselected. The app has no
 * recipient parameter, so the user withdraws DASH to the bridge address there.
 */
export function nearIntentsAppUrl(token?: Pick<NearIntentsToken, 'symbol' | 'blockchain'>): string {
  const from = token ? `from=${encodeURIComponent(token.symbol)}:${encodeURIComponent(token.blockchain)}&` : '';
  return `${NEAR_INTENTS_APP_URL}?${from}to=DASH`;
}

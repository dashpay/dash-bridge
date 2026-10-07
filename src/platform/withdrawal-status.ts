/**
 * Withdrawal document lifecycle statuses. The validator quorum moves a
 * withdrawal through these states; the client only observes them.
 *
 * Kept in a leaf module (no SDK imports) so the eagerly-loaded UI layer can
 * use the constants without pulling the lazily-loaded platform chunk into
 * the main bundle.
 */
export const WithdrawalStatus = {
  QUEUED: 0,
  POOLED: 1,
  BROADCASTED: 2,
  COMPLETE: 3,
  EXPIRED: 4,
} as const;

/** Result of one withdrawal-document lookup made to disambiguate a submission error. */
export type WithdrawalLookupResult = 'found' | 'not_found' | 'error';

/** Whether a withdrawal whose submission errored actually landed. */
export type WithdrawalLandedOutcome = 'found' | 'not_found' | 'unknown';

/**
 * Combine the landed-check lookups (in the order they ran) into a verdict.
 * Any hit means the withdrawal landed. "not_found" requires the final lookup
 * to have succeeded and returned no record — the latest lookup gave Platform
 * the most time to process the transition. Otherwise (e.g. the final lookup
 * errored) the outcome is unknown and a retry would be unsafe.
 */
export function classifyWithdrawalLookups(
  results: readonly WithdrawalLookupResult[]
): WithdrawalLandedOutcome {
  if (results.includes('found')) return 'found';
  if (results.length > 0 && results[results.length - 1] === 'not_found') return 'not_found';
  return 'unknown';
}

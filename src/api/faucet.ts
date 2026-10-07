/**
 * Faucet API client with CAP (proof-of-work) support
 */

import { fetchWithDeadline, RequestTimeoutError } from '../utils/fetch-with-deadline.js';

// Declare the global Cap class from @cap.js/widget
declare const Cap: {
  new (options: { apiEndpoint: string }): {
    solve(): Promise<{ success: boolean; token: string }>;
  };
};

let capWidgetPromise: Promise<void> | null = null;

/** Default timeout for faucet API requests (30 seconds) */
const REQUEST_TIMEOUT_MS = 30000;
const CAP_WIDGET_SRC = 'https://cdn.jsdelivr.net/npm/@cap.js/widget@0.1.54';
/** A Dash transaction ID: 32 bytes as hex. */
const TXID_PATTERN = /^[0-9a-f]{64}$/i;

export interface FaucetStatus {
  status: string;
  /** If present, CAP proof-of-work is required */
  capEndpoint?: string;
}

export interface FaucetResponse {
  txid: string;
  amount: number;
  address: string;
}

/**
 * Fetch with one timeout covering both the response headers and the body
 * read performed by `read`. Never retried automatically, so a timed-out
 * faucet POST cannot be re-sent without the user asking again.
 */
async function fetchWithTimeout<T>(
  url: string,
  options: RequestInit,
  read: (response: Response) => Promise<T>,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> {
  try {
    return await fetchWithDeadline(url, options, timeoutMs, read);
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new Error('Request timed out. Please try again.');
    }
    throw error;
  }
}

/**
 * Safely extract error message from various API response formats
 */
function extractErrorMessage(errorData: unknown, fallbackStatus: number): string {
  if (!errorData || typeof errorData !== 'object') {
    return `Faucet request failed: ${fallbackStatus}`;
  }

  const data = errorData as Record<string, unknown>;

  // Try common error message fields
  if (typeof data.error === 'string' && data.error) {
    return data.error;
  }
  if (typeof data.message === 'string' && data.message) {
    return data.message;
  }
  if (typeof data.detail === 'string' && data.detail) {
    return data.detail;
  }

  // For array details (like Pydantic validation errors)
  if (Array.isArray(data.detail) && data.detail.length > 0) {
    const firstError = data.detail[0];
    if (typeof firstError === 'object' && firstError && 'msg' in firstError) {
      return String(firstError.msg);
    }
  }

  return `Faucet request failed: ${fallbackStatus}`;
}

/**
 * Fetch faucet status to check if CAP is required
 */
export async function getFaucetStatus(baseUrl: string): Promise<FaucetStatus> {
  return fetchWithTimeout(`${baseUrl}/api/status`, {}, async (response) => {
    if (!response.ok) {
      throw new Error(`Failed to fetch faucet status: ${response.status}`);
    }

    return response.json();
  });
}

/**
 * Solve CAP proof-of-work challenge
 * Uses the global Cap class from @cap.js/widget loaded via CDN
 */
export async function solveCap(capEndpoint: string): Promise<string> {
  await loadCapWidget();

  if (typeof Cap === 'undefined') {
    throw new Error('CAP widget not loaded. Please refresh the page.');
  }

  const cap = new Cap({ apiEndpoint: capEndpoint });
  const result = await cap.solve();

  if (!result.success) {
    throw new Error('CAP challenge failed');
  }

  return result.token;
}

function loadCapWidget(): Promise<void> {
  if (typeof Cap !== 'undefined') {
    return Promise.resolve();
  }

  if (!capWidgetPromise) {
    capWidgetPromise = new Promise<void>((resolve, reject) => {
      const watchScript = (script: HTMLScriptElement) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
          rejectScript(new Error('Timed out loading CAP widget'));
        }, REQUEST_TIMEOUT_MS);

        const cleanup = () => {
          settled = true;
          clearTimeout(timeoutId);
          script.removeEventListener('load', handleLoad);
          script.removeEventListener('error', handleError);
        };

        const rejectScript = (error: Error) => {
          if (settled) return;
          cleanup();
          script.remove();
          reject(error);
        };

        const handleLoad = () => {
          if (settled) return;
          cleanup();
          if (typeof Cap === 'undefined') {
            script.remove();
            reject(new Error('CAP widget loaded without exposing Cap'));
            return;
          }
          resolve();
        };

        const handleError = () => {
          rejectScript(new Error('Failed to load CAP widget'));
        };

        script.addEventListener('load', handleLoad, { once: true });
        script.addEventListener('error', handleError, { once: true });
      };

      const existing = document.querySelector<HTMLScriptElement>('script[data-cap-widget]');
      if (existing) {
        watchScript(existing);
        return;
      }

      const script = document.createElement('script');
      script.src = CAP_WIDGET_SRC;
      script.async = true;
      script.dataset.capWidget = 'true';
      watchScript(script);
      document.head.appendChild(script);
    }).catch((err) => {
      capWidgetPromise = null;
      throw err;
    });
  }

  return capWidgetPromise;
}

/**
 * Request testnet funds from the faucet
 */
export async function requestTestnetFunds(
  baseUrl: string,
  address: string,
  amount: number = 1.0,
  capToken?: string
): Promise<FaucetResponse> {
  const body: Record<string, unknown> = {
    address,
    amount,
  };

  if (capToken) {
    body.capToken = capToken;
  }

  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };

  // Once the faucet answers 2xx it has most likely sent funds, so a failed
  // body read must not invite the user to request again.
  let accepted = false;
  let data: Record<string, unknown> | null;
  try {
    data = await fetchWithTimeout(`${baseUrl}/api/core-faucet`, init, async (response) => {
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        if (response.status === 429) {
          const data = errorData as Record<string, unknown>;
          const retryAfter = typeof data.retryAfter === 'number' ? data.retryAfter : undefined;
          if (retryAfter) {
            const minutes = Math.ceil(retryAfter / 60);
            throw new Error(`Rate limit exceeded. Try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`);
          }
          throw new Error('Rate limit exceeded. Please try again later.');
        }

        throw new Error(extractErrorMessage(errorData, response.status));
      }

      accepted = true;
      return (await response.json()) as Record<string, unknown> | null;
    });
  } catch (error) {
    if (accepted) {
      throw new Error(
        'The faucet accepted the request but its reply did not complete. Funds may already be on the way; wait for the deposit before requesting again.'
      );
    }
    throw error;
  }

  // The txid is rendered into the page, so only accept a real 32-byte hex txid.
  // The 2xx means funds were most likely sent, so don't invite a second request.
  if (!data || typeof data.txid !== 'string' || !TXID_PATTERN.test(data.txid)) {
    throw new Error(
      'The faucet accepted the request but returned an invalid transaction ID. Funds may already be on the way; wait for the deposit before requesting again.'
    );
  }

  return data as unknown as FaucetResponse;
}

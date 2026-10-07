import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ScriptEvent = 'load' | 'error';

class FakeScript {
  async = false;
  dataset: Record<string, string> = {};
  removed = false;
  src = '';

  private listeners: Record<ScriptEvent, Set<() => void>> = {
    error: new Set(),
    load: new Set(),
  };

  addEventListener(type: ScriptEvent, listener: () => void): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: ScriptEvent, listener: () => void): void {
    this.listeners[type].delete(listener);
  }

  dispatch(type: ScriptEvent): void {
    for (const listener of [...this.listeners[type]]) {
      listener();
    }
  }

  remove(): void {
    this.removed = true;
  }
}

function installFakeDocument(): { scripts: FakeScript[] } {
  const scripts: FakeScript[] = [];

  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'script') throw new Error(`unexpected tag: ${tag}`);
      return new FakeScript();
    },
    head: {
      appendChild: (script: FakeScript) => {
        scripts.push(script);
        return script;
      },
    },
    querySelector: () => scripts.find((script) => script.dataset.capWidget === 'true' && !script.removed) ?? null,
  });

  return { scripts };
}

function installCap(token = 'cap-token'): void {
  vi.stubGlobal(
    'Cap',
    class {
      solve = vi.fn(async () => ({ success: true, token }));
    }
  );
}

describe('solveCap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('removes a failed CAP widget script so retry can inject a fresh tag', async () => {
    const { scripts } = installFakeDocument();
    const { solveCap } = await import('./faucet.js');

    const firstAttempt = solveCap('/cap');
    const firstExpectation = expect(firstAttempt).rejects.toThrow('Failed to load CAP widget');
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe('https://cdn.jsdelivr.net/npm/@cap.js/widget@0.1.54');

    scripts[0].dispatch('error');
    await firstExpectation;
    expect(scripts[0].removed).toBe(true);

    const secondAttempt = solveCap('/cap');
    expect(scripts).toHaveLength(2);
    installCap('retry-token');
    scripts[1].dispatch('load');

    await expect(secondAttempt).resolves.toBe('retry-token');
  });

  it('times out and removes the CAP widget script when the CDN stalls', async () => {
    const { scripts } = installFakeDocument();
    const { solveCap } = await import('./faucet.js');

    const attempt = solveCap('/cap');
    const expectation = expect(attempt).rejects.toThrow('Timed out loading CAP widget');

    expect(scripts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
    expect(scripts[0].removed).toBe(true);
  });
});

describe('requestTestnetFunds', () => {
  const VALID_TXID = 'a'.repeat(32) + 'B'.repeat(32);

  function stubFaucetResponse(body: unknown): void {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a response with a hex txid', async () => {
    stubFaucetResponse({ txid: VALID_TXID, amount: 1, address: 'yAddr' });
    const { requestTestnetFunds } = await import('./faucet.js');

    await expect(requestTestnetFunds('https://faucet.example', 'yAddr')).resolves.toMatchObject({ txid: VALID_TXID });
  });

  it.each([
    '<img src=x onerror=alert(1)>',
    `${VALID_TXID}"><img src=x onerror=alert(1)>`,
    'abc',
    VALID_TXID.slice(1) + 'g',
    42,
    undefined,
  ])('rejects a success response whose txid is not 64 hex characters: %s', async (txid) => {
    stubFaucetResponse({ txid, amount: 1, address: 'yAddr' });
    const { requestTestnetFunds } = await import('./faucet.js');

    await expect(requestTestnetFunds('https://faucet.example', 'yAddr')).rejects.toThrow(
      'The faucet accepted the request but returned an invalid transaction ID. Funds may already be on the way; wait for the deposit before requesting again.'
    );
  });
});

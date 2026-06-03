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

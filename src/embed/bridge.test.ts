import { describe, it, expect, vi } from 'vitest';
import { resolveEmbed, toProgressStep, EmbedSession } from './bridge.js';
import { createInitialState, setMode, setIdentityRegistered, setError, setStep } from '../ui/state.js';
import type { BridgeState } from '../types.js';

const APP_ORIGIN = 'https://app.example';
const IDENTITY_ID = '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA';

interface FakeWindowOptions {
  search: string;
  framed?: boolean;
  ancestorOrigins?: string[];
  referrer?: string;
  hasOpener?: boolean;
}

function fakeWindow(opts: FakeWindowOptions) {
  const target = { postMessage: vi.fn() };
  const win: Record<string, unknown> = {
    location: {
      search: opts.search,
      href: `https://bridge.example/${opts.search}`,
      ancestorOrigins: opts.ancestorOrigins,
    },
    document: { referrer: opts.referrer ?? '' },
    opener: opts.hasOpener === false ? null : target,
    close: vi.fn(),
    confirm: vi.fn(() => true),
  };
  win.self = win;
  win.top = opts.framed ? {} : win;
  win.parent = opts.framed ? target : win;
  return { win: win as unknown as Window, target };
}

function posted(target: { postMessage: ReturnType<typeof vi.fn> }) {
  return target.postMessage.mock.calls.map(([msg]) => msg as Record<string, unknown>);
}

function createState(): BridgeState {
  return setMode(createInitialState('testnet'), 'create');
}

describe('toProgressStep', () => {
  it('maps create-flow steps to coarse steps and ignores the rest', () => {
    expect(toProgressStep('configure_keys')).toBe('configuring');
    expect(toProgressStep('detecting_deposit')).toBe('awaiting_deposit');
    expect(toProgressStep('waiting_islock')).toBe('processing');
    expect(toProgressStep('registering_identity')).toBe('registering');
    expect(toProgressStep('complete')).toBe('complete');
    expect(toProgressStep('dpns_enter_usernames')).toBeUndefined();
  });
});

describe('resolveEmbed', () => {
  it('runs normally when not embedded and not framed', () => {
    const { win } = fakeWindow({ search: '?network=testnet' });
    expect(resolveEmbed(win)).toEqual({ action: 'run' });
  });

  it('refuses to run framed without embed=iframe (clickjacking guard)', () => {
    const { win } = fakeWindow({ search: '?network=testnet', framed: true });
    const result = resolveEmbed(win);
    expect(result.action).toBe('block');
    expect(result.action === 'block' && result.notice.openHref).toBe('https://bridge.example/?network=testnet');
  });

  it('refuses popup mode inside a frame', () => {
    const { win } = fakeWindow({ search: `?embed=popup&origin=${APP_ORIGIN}`, framed: true });
    const result = resolveEmbed(win);
    expect(result.action).toBe('block');
    expect(result.action === 'block' && result.notice.openHref).toBe('https://bridge.example/');
  });

  it('accepts an iframe whose ancestor matches the declared origin', () => {
    const { win } = fakeWindow({
      search: `?embed=iframe&origin=${APP_ORIGIN}`,
      framed: true,
      ancestorOrigins: [APP_ORIGIN],
    });
    const result = resolveEmbed(win);
    expect(result.action).toBe('run');
    expect(result.action === 'run' && result.session?.display).toEqual({
      kind: 'iframe',
      origin: APP_ORIGIN,
      appName: undefined,
    });
  });

  it('refuses an iframe whose ancestor does not match the declared origin', () => {
    const { win, target } = fakeWindow({
      search: `?embed=iframe&origin=${APP_ORIGIN}`,
      framed: true,
      ancestorOrigins: ['https://evil.example'],
    });
    expect(resolveEmbed(win).action).toBe('block');
    expect(target.postMessage).not.toHaveBeenCalled();
  });

  it('falls back to the referrer origin when ancestorOrigins is unavailable', () => {
    const search = `?embed=iframe&origin=${APP_ORIGIN}`;
    expect(resolveEmbed(fakeWindow({ search, framed: true, referrer: 'https://evil.example/' }).win).action).toBe('block');
    expect(resolveEmbed(fakeWindow({ search, framed: true, referrer: `${APP_ORIGIN}/page` }).win).action).toBe('run');
  });

  it('refuses iframe mode when not actually framed', () => {
    const { win } = fakeWindow({ search: `?embed=iframe&origin=${APP_ORIGIN}` });
    expect(resolveEmbed(win).action).toBe('block');
  });

  it('refuses popup mode without an opener', () => {
    const { win } = fakeWindow({ search: `?embed=popup&origin=${APP_ORIGIN}`, hasOpener: false });
    expect(resolveEmbed(win).action).toBe('block');
  });

  it('blocks invalid requests without messaging anyone', () => {
    const { win, target } = fakeWindow({ search: '?embed=popup&origin=http://app.example' });
    expect(resolveEmbed(win).action).toBe('block');
    expect(target.postMessage).not.toHaveBeenCalled();
  });

  it('tells the app about unsupported requests with a fatal error', () => {
    const { win, target } = fakeWindow({ search: `?embed=popup&origin=${APP_ORIGIN}&request=login&requestId=r1` });
    expect(resolveEmbed(win).action).toBe('block');
    expect(target.postMessage).toHaveBeenCalledWith(
      {
        source: 'dash-bridge',
        version: 1,
        type: 'error',
        request: 'login',
        requestId: 'r1',
        code: 'unsupported_request',
        message: expect.any(String),
        fatal: true,
      },
      APP_ORIGIN,
    );
  });
});

describe('EmbedSession', () => {
  function startSession(search = `?embed=popup&origin=${APP_ORIGIN}&requestId=r1&app=Demo`) {
    const fake = fakeWindow({ search });
    const result = resolveEmbed(fake.win);
    if (result.action !== 'run' || !result.session) throw new Error('expected a session');
    return { ...fake, session: result.session };
  }

  it('posts only to the declared origin, never "*"', () => {
    const { session, target } = startSession();
    const state = createState();
    session.start(state);
    session.onStateChange(state, setIdentityRegistered(state, IDENTITY_ID));
    expect(target.postMessage.mock.calls.length).toBeGreaterThan(0);
    for (const [, targetOrigin] of target.postMessage.mock.calls) {
      expect(targetOrigin).toBe(APP_ORIGIN);
    }
  });

  it('reports ready, deduplicated progress, and the created identity without secrets', () => {
    const { session, target } = startSession();
    let state = createState();
    expect(state.mnemonic).toBeTruthy();
    session.start(state);

    const steps: BridgeState['step'][] = ['generating_keys', 'detecting_deposit', 'broadcasting', 'waiting_islock', 'registering_identity'];
    for (const step of steps) {
      const next = setStep(state, step);
      session.onStateChange(state, next);
      state = next;
    }
    session.onStateChange(state, setIdentityRegistered(state, IDENTITY_ID));

    const msgs = posted(target);
    expect(msgs.map((m) => (m.type === 'progress' ? `progress:${m.step}` : m.type))).toEqual([
      'ready',
      'progress:configuring',
      'progress:awaiting_deposit',
      'progress:processing',
      'progress:registering',
      'progress:complete',
      'identity-created',
    ]);
    expect(msgs[msgs.length - 1]).toEqual({
      source: 'dash-bridge',
      version: 1,
      type: 'identity-created',
      request: 'create-identity',
      requestId: 'r1',
      identityId: IDENTITY_ID,
      network: 'testnet',
    });
    expect(JSON.stringify(msgs)).not.toContain(state.mnemonic!);
  });

  it('reports recoverable errors with the static label only', () => {
    const { session, target } = startSession();
    const state = setStep(createState(), 'waiting_islock');
    session.onStateChange(state, setError(state, new Error('secret detail cVt4o7BG'), 'ERR-1005'));
    const error = posted(target).find((m) => m.type === 'error');
    expect(error).toMatchObject({ code: 'ERR-1005', fatal: false });
    expect(String(error?.message)).not.toContain('secret');
  });

  it('cancels without confirmation before keys exist, and closes the popup', () => {
    const { session, target, win } = startSession();
    const confirm = vi.fn(() => true);
    expect(session.cancel(createState(), confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(posted(target).map((m) => m.type)).toEqual(['cancelled']);
    expect(win.close).toHaveBeenCalled();
    // Nothing more after cancelling, not even on pagehide.
    session.handlePageHide();
    expect(posted(target)).toHaveLength(1);
  });

  it('asks before cancelling once a deposit address exists', () => {
    const { session, target } = startSession();
    const state = { ...createState(), step: 'detecting_deposit' as const, assetLockKeyPair: { privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) } };
    expect(session.cancel(state, () => false)).toBe(false);
    expect(target.postMessage).not.toHaveBeenCalled();
    expect(session.cancel(state, () => true)).toBe(true);
    expect(posted(target).map((m) => m.type)).toEqual(['cancelled']);
  });

  it('does not report cancelled on pagehide after the identity was created', () => {
    const { session, target } = startSession();
    const state = createState();
    session.onStateChange(state, setIdentityRegistered(state, IDENTITY_ID));
    session.handlePageHide();
    expect(posted(target).map((m) => m.type)).not.toContain('cancelled');
  });

  it('returnToApp closes the popup, or asks the iframe host to close', () => {
    const popup = startSession();
    popup.session.returnToApp();
    expect(popup.win.close).toHaveBeenCalled();

    const fake = fakeWindow({ search: `?embed=iframe&origin=${APP_ORIGIN}`, framed: true, ancestorOrigins: [APP_ORIGIN] });
    new EmbedSession({ kind: 'iframe', origin: APP_ORIGIN, request: 'create-identity', network: 'testnet' }, fake.win).returnToApp();
    expect(posted(fake.target).map((m) => m.type)).toEqual(['close']);
    expect(fake.win.close).not.toHaveBeenCalled();
  });
});

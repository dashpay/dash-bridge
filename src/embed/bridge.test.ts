import { describe, it, expect, vi } from 'vitest';
import { resolveEmbed, toProgressStep, canCancel, EmbedSession, EXPIRED_NOTICE } from './bridge.js';
import { createInitialState, setMode, setIdentityRegistered, setError, setStep } from '../ui/state.js';
import type { BridgeState } from '../types.js';
import { parseLoginFragment, type LoginResult } from './login.js';

const APP_ORIGIN = 'https://app.example';
const IDENTITY_ID = '4ufjwRfdhMM87uBaGmTvesgLm6k2Q2r7SVyZdTUzFebA';

interface FakeWindowOptions {
  search: string;
  framed?: boolean;
  ancestorOrigins?: string[];
  referrer?: string;
  hasOpener?: boolean;
  navigationType?: string;
}

function fakeWindow(opts: FakeWindowOptions) {
  const target = { postMessage: vi.fn() };
  const win: Record<string, unknown> = {
    location: {
      search: opts.search,
      href: `https://bridge.example/${opts.search}`,
      ancestorOrigins: opts.ancestorOrigins,
      replace: vi.fn(),
    },
    document: { referrer: opts.referrer ?? '' },
    opener: opts.hasOpener === false ? null : target,
    close: vi.fn(),
    confirm: vi.fn(() => true),
    performance: { getEntriesByType: () => [{ type: opts.navigationType ?? 'navigate' }] },
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
    expect(toProgressStep('mobile_app_recommended')).toBe('configuring');
    expect(toProgressStep('configure_keys')).toBe('configuring');
    expect(toProgressStep('detecting_deposit')).toBe('awaiting_deposit');
    expect(toProgressStep('waiting_islock')).toBe('processing');
    expect(toProgressStep('registering_identity')).toBe('registering');
    expect(toProgressStep('complete')).toBe('complete');
    expect(toProgressStep('dpns_enter_usernames')).toBeUndefined();
  });
});

describe('canCancel', () => {
  it('allows cancelling before registration', () => {
    expect(canCancel({ step: 'awaiting_deposit' })).toBe(true);
    expect(canCancel({ step: 'error', errorStep: 'detecting_deposit' })).toBe(true);
  });

  it('refuses once the identity may be on its way to Platform', () => {
    expect(canCancel({ step: 'registering_identity' })).toBe(false);
    expect(canCancel({ step: 'complete' })).toBe(false);
    expect(canCancel({ step: 'error', errorStep: 'registering_identity' })).toBe(false);
    expect(canCancel({ step: 'error', unconfirmedIdentityId: 'abc' })).toBe(false);
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
      request: 'create-identity',
      statement: undefined,
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

  it('refuses an iframe whose framer is unknown (no ancestorOrigins, no referrer)', () => {
    const { win, target } = fakeWindow({ search: `?embed=iframe&origin=${APP_ORIGIN}`, framed: true });
    const result = resolveEmbed(win);
    expect(result.action).toBe('block');
    expect(result.action === 'block' && result.notice.title).toBe('Request refused');
    expect(target.postMessage).not.toHaveBeenCalled();
  });

  it('shows the real reason for an invalid iframe request, not the framing notice', () => {
    const { win } = fakeWindow({ search: '?embed=iframe&origin=http://app.example', framed: true });
    const result = resolveEmbed(win);
    expect(result.action === 'block' && result.notice.title).toBe('Invalid request');
  });

  it('builds the new-window link from scratch, dropping deep-link params', () => {
    const { win } = fakeWindow({ search: '?network=mainnet&address=evil&mode=withdraw', framed: true });
    const result = resolveEmbed(win);
    expect(result.action === 'block' && result.notice.openHref).toBe('https://bridge.example/?network=mainnet');
  });

  it.each(['reload', 'back_forward'])('treats a %s of an embed request as expired', (navigationType) => {
    const { win, target } = fakeWindow({ search: `?embed=popup&origin=${APP_ORIGIN}`, navigationType });
    expect(resolveEmbed(win)).toEqual({ action: 'block', notice: EXPIRED_NOTICE });
    expect(target.postMessage).not.toHaveBeenCalled();
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
    const { win, target } = fakeWindow({ search: `?embed=popup&origin=${APP_ORIGIN}&request=sign-tx&requestId=r1` });
    expect(resolveEmbed(win).action).toBe('block');
    expect(target.postMessage).toHaveBeenCalledWith(
      {
        source: 'dash-bridge',
        version: 1,
        type: 'error',
        request: 'sign-tx',
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

  it('sends identity-created exactly once', () => {
    const { session, target } = startSession();
    const state = setStep(createState(), 'registering_identity');
    const done = setIdentityRegistered(state, IDENTITY_ID);
    session.onStateChange(state, done);
    session.onStateChange(done, { ...done });
    session.onStateChange(state, done);
    expect(posted(target).filter((m) => m.type === 'identity-created')).toHaveLength(1);
  });

  it('cannot be cancelled while registering or once complete, and shows a notice after cancelling', () => {
    const { session, target } = startSession();
    expect(session.cancel(setStep(createState(), 'registering_identity'))).toBe(false);
    expect(session.cancel(setIdentityRegistered(createState(), IDENTITY_ID))).toBe(false);
    expect(target.postMessage).not.toHaveBeenCalled();
    expect(session.notice).toBeUndefined();
    expect(session.cancel(createState())).toBe(true);
    expect(session.notice?.title).toBe('Request cancelled');
  });

  it('never reports cancelled on popup pagehide (a reload must not orphan the request)', () => {
    const { session, target } = startSession();
    session.handlePageHide();
    expect(target.postMessage).not.toHaveBeenCalled();
    // Still able to deliver the result afterwards (e.g. pagehide from a cancelled navigation).
    const state = createState();
    session.onStateChange(state, setIdentityRegistered(state, IDENTITY_ID));
    expect(posted(target).map((m) => m.type)).toContain('identity-created');
  });

  it('reports cancelled once on iframe pagehide, but not after a result', () => {
    const fake = fakeWindow({ search: '', framed: true });
    const params = { kind: 'iframe' as const, origin: APP_ORIGIN, request: 'create-identity' as const, network: 'testnet' as const };
    const session = new EmbedSession(params, fake.win);
    session.handlePageHide();
    session.handlePageHide();
    expect(posted(fake.target).map((m) => m.type)).toEqual(['cancelled']);

    const done = fakeWindow({ search: '', framed: true });
    const finished = new EmbedSession(params, done.win);
    const state = createState();
    finished.onStateChange(state, setIdentityRegistered(state, IDENTITY_ID));
    finished.handlePageHide();
    expect(posted(done.target).map((m) => m.type)).toEqual(['progress', 'identity-created']);
  });

  it('expire() stops all messages and shows the expired notice', () => {
    const { session, target } = startSession();
    session.expire();
    expect(session.notice).toBe(EXPIRED_NOTICE);
    const state = createState();
    session.onStateChange(state, setIdentityRegistered(state, IDENTITY_ID));
    expect(target.postMessage).not.toHaveBeenCalled();
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

describe('login requests', () => {
  const NONCE = 'abcdefghijklmnop1234';
  const RETURN_URL = `${APP_ORIGIN}/auth/callback`;
  const RESULT: LoginResult = {
    identityId: IDENTITY_ID,
    keyId: 1,
    network: 'testnet',
    message: 'app.example wants you to sign in ...',
    signature: 'H'.repeat(88),
    nonce: NONCE,
    issuedAt: '2026-10-07T12:00:00Z',
    expiresAt: '2026-10-07T12:10:00Z',
  };
  const loginSearch = (kind: string, extra = '') =>
    `?embed=${kind}&origin=${APP_ORIGIN}&request=login&nonce=${NONCE}&requestId=r1&statement=Hello${extra}`;
  const replaced = (win: Window) => (win.location.replace as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => url as string);

  function session(search: string, opts: Partial<FakeWindowOptions> = {}) {
    const fake = fakeWindow({ search, ...opts });
    const result = resolveEmbed(fake.win);
    if (result.action !== 'run' || !result.session) throw new Error('expected a session');
    return { ...fake, session: result.session };
  }

  it('exposes the login request and statement for display', () => {
    const { session: s } = session(loginSearch('popup'));
    expect(s.display).toMatchObject({ request: 'login', statement: 'Hello', origin: APP_ORIGIN });
    expect(s.login).toEqual({ nonce: NONCE, statement: 'Hello', returnUrl: undefined });
  });

  it('popup: posts the login result once to the declared origin, then closes', () => {
    const { session: s, target, win } = session(loginSearch('popup'));
    s.completeLogin({ ...RESULT, privateKeyWif: 'cSecretWif' } as LoginResult);
    s.completeLogin(RESULT);
    expect(target.postMessage).toHaveBeenCalledTimes(1);
    expect(target.postMessage).toHaveBeenCalledWith(
      { source: 'dash-bridge', version: 1, type: 'login', request: 'login', requestId: 'r1', ...RESULT },
      APP_ORIGIN,
    );
    expect(win.close).toHaveBeenCalled();
  });

  it('refuses iframe logins and tells the framing app', () => {
    const { win, target } = fakeWindow({ search: loginSearch('iframe'), framed: true, ancestorOrigins: [APP_ORIGIN] });
    const result = resolveEmbed(win);
    expect(result.action === 'block' && result.notice.title).toBe('Unsupported request');
    expect(posted(target)).toEqual([
      expect.objectContaining({ type: 'error', request: 'login', code: 'unsupported_mode', fatal: true }),
    ]);
  });

  it('cannot be cancelled after the login was delivered', () => {
    const { session: s, target } = session(loginSearch('popup'));
    expect(s.cancel({ ...createInitialState('testnet'), mode: 'login', step: 'login_complete' })).toBe(false);
    expect(s.cancel({ ...createInitialState('testnet'), mode: 'login', step: 'login_cancelled' })).toBe(false);
    expect(target.postMessage).not.toHaveBeenCalled();
  });

  describe('redirect mode', () => {
    const search = loginSearch('redirect', `&returnUrl=${encodeURIComponent(RETURN_URL)}`);
    const fromApp = { hasOpener: false, referrer: `${APP_ORIGIN}/login` };

    it('runs top-level without an opener when the app sent the user', () => {
      expect(resolveEmbed(fakeWindow({ search, ...fromApp }).win).action).toBe('run');
    });

    it.each([
      ['no referrer', '', "couldn't confirm which site sent you"],
      ['another site', 'https://evil.example/phish', 'different site'],
      ['a lookalike host', 'https://app.example.evil.example/', 'different site'],
    ])('refuses a request from %s without redirecting anywhere', (_label, referrer, text) => {
      const { win } = fakeWindow({ search, hasOpener: false, referrer });
      const result = resolveEmbed(win);
      expect(result.action === 'block' && result.notice.title).toBe('Request refused');
      expect(result.action === 'block' && result.notice.message).toContain(text);
      expect(replaced(win)).toEqual([]);
    });

    it('sends an unsupported network back as an error, but only for the app itself', () => {
      const devnet = loginSearch('redirect', `&returnUrl=${encodeURIComponent(RETURN_URL)}`).replace('request=login', 'request=login&network=devnet');
      const ok = fakeWindow({ search: devnet, ...fromApp });
      expect(resolveEmbed(ok.win).action).toBe('block');
      expect(replaced(ok.win)).toEqual([`${RETURN_URL}#dash_login_error=unsupported_network`]);

      const spoofed = fakeWindow({ search: devnet, hasOpener: false, referrer: 'https://evil.example/' });
      expect(resolveEmbed(spoofed.win).action).toBe('block');
      expect(replaced(spoofed.win)).toEqual([]);
    });

    it('refuses to run framed', () => {
      const result = resolveEmbed(fakeWindow({ search, framed: true, ancestorOrigins: [APP_ORIGIN] }).win);
      expect(result.action === 'block' && result.notice.title).toBe("This page can't run inside another site");
    });

    it('expires on reload', () => {
      expect(resolveEmbed(fakeWindow({ search, navigationType: 'reload' }).win)).toEqual({ action: 'block', notice: EXPIRED_NOTICE });
    });

    it('navigates back with the result in the fragment, once, posting nothing', () => {
      const { session: s, target, win } = session(search, fromApp);
      s.start(createInitialState('testnet'));
      s.completeLogin({ ...RESULT, privateKeyWif: 'cSecretWif' } as LoginResult);
      s.completeLogin(RESULT);
      const urls = replaced(win);
      expect(urls).toHaveLength(1);
      const url = new URL(urls[0]);
      expect(url.origin + url.pathname).toBe(RETURN_URL);
      expect(parseLoginFragment(url.hash)).toEqual(RESULT);
      expect(urls[0]).not.toContain('cSecretWif');
      expect(target.postMessage).not.toHaveBeenCalled();
    });

    it('navigates back with dash_login_error=cancelled on cancel', () => {
      const { session: s, win } = session(search, fromApp);
      expect(s.cancel({ ...createInitialState('testnet'), mode: 'login', step: 'login_input' })).toBe(true);
      expect(replaced(win)).toEqual([`${RETURN_URL}#dash_login_error=cancelled`]);
      s.completeLogin(RESULT);
      expect(replaced(win)).toHaveLength(1);
    });
  });
});

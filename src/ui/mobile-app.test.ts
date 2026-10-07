// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import {
  DASHPAY_APP_STORE_URL,
  DASHPAY_GOOGLE_PLAY_URL,
  detectMobilePlatform,
  getStoreUrl,
  shouldRecommendMobileApp,
  syncSmartAppBanner,
} from './mobile-app.js';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const MAC_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

describe('detectMobilePlatform', () => {
  it.each([
    ['iPhone', IPHONE_UA, 'iPhone', 5, 'ios'],
    ['iPad', IPAD_UA, 'iPad', 5, 'ios'],
    ['iPadOS in desktop mode', MAC_SAFARI_UA, 'MacIntel', 5, 'ios'],
    ['Mac without touch', MAC_SAFARI_UA, 'MacIntel', 0, 'desktop'],
    ['Android phone', ANDROID_UA, 'Linux armv81', 5, 'android'],
    ['Windows desktop', WINDOWS_UA, 'Win32', 0, 'desktop'],
    ['touch-screen Windows laptop', WINDOWS_UA, 'Win32', 10, 'desktop'],
    ['empty values', '', '', 0, 'desktop'],
  ] as const)('%s', (_name, ua, platform, touchPoints, expected) => {
    expect(detectMobilePlatform(ua, platform, touchPoints)).toBe(expected);
  });
});

describe('getStoreUrl', () => {
  it('maps each phone platform to its store and desktop to none', () => {
    expect(getStoreUrl('ios')).toBe(DASHPAY_APP_STORE_URL);
    expect(getStoreUrl('android')).toBe(DASHPAY_GOOGLE_PLAY_URL);
    expect(getStoreUrl('desktop')).toBeUndefined();
  });
});

describe('shouldRecommendMobileApp', () => {
  it('only recommends the app on mainnet', () => {
    expect(shouldRecommendMobileApp('mainnet')).toBe(true);
    expect(shouldRecommendMobileApp('testnet')).toBe(false);
    expect(shouldRecommendMobileApp('my-devnet')).toBe(false);
  });
});

describe('syncSmartAppBanner', () => {
  const banners = () => document.head.querySelectorAll('meta[name="apple-itunes-app"]');

  afterEach(() => {
    banners().forEach((meta) => meta.remove());
  });

  it('adds one banner tag on mainnet and removes it when leaving mainnet', () => {
    syncSmartAppBanner(document, 'mainnet');
    syncSmartAppBanner(document, 'mainnet');
    expect(banners()).toHaveLength(1);
    expect(banners()[0].getAttribute('content')).toBe('app-id=1206647026');

    syncSmartAppBanner(document, 'testnet');
    expect(banners()).toHaveLength(0);
  });

  it('does not add the banner off mainnet', () => {
    syncSmartAppBanner(document, 'testnet');
    expect(banners()).toHaveLength(0);
  });
});

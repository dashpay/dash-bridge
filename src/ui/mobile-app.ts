/**
 * DashPay (Dash Wallet) mobile app recommendation.
 *
 * On mainnet the bridge steers people to the DashPay app, which creates the
 * identity and username with keys generated and kept on the phone. Neither the
 * iOS nor the Android app has a deep link to its create-username screen (and a
 * bare `dashwallet://` shows an error), so the store page is the redirect: it
 * shows "Open" when the app is already installed.
 */

export const DASHPAY_IOS_APP_ID = '1206647026';
export const DASHPAY_APP_STORE_URL = `https://apps.apple.com/app/id${DASHPAY_IOS_APP_ID}`;
export const DASHPAY_GOOGLE_PLAY_URL =
  'https://play.google.com/store/apps/details?id=hashengineering.darkcoin.wallet';
export const DASHPAY_ANDROID_APK_URL = 'https://github.com/dashpay/dash-wallet/releases/latest';

export type MobilePlatform = 'ios' | 'android' | 'desktop';

/** Whether the bridge should point people at the DashPay app on this network. */
export function shouldRecommendMobileApp(network: string): boolean {
  return network === 'mainnet';
}

/**
 * Classify the device. iPadOS reports itself as desktop Safari ("MacIntel"),
 * so a Mac with a touch screen is treated as iOS.
 */
export function detectMobilePlatform(
  userAgent: string,
  platform: string,
  maxTouchPoints: number
): MobilePlatform {
  if (/android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  if (platform === 'MacIntel' && maxTouchPoints > 1) return 'ios';
  return 'desktop';
}

/** {@link detectMobilePlatform} for the current browser. */
export function getCurrentMobilePlatform(): MobilePlatform {
  if (typeof navigator === 'undefined') return 'desktop';
  return detectMobilePlatform(
    navigator.userAgent ?? '',
    navigator.platform ?? '',
    navigator.maxTouchPoints ?? 0
  );
}

/** Store page for the platform's app; desktop has no single store. */
export function getStoreUrl(platform: MobilePlatform): string | undefined {
  if (platform === 'ios') return DASHPAY_APP_STORE_URL;
  if (platform === 'android') return DASHPAY_GOOGLE_PLAY_URL;
  return undefined;
}

const SMART_APP_BANNER_NAME = 'apple-itunes-app';

/**
 * Add Safari's Smart App Banner on mainnet and remove it elsewhere. Other
 * browsers ignore the tag. Safari only reads it while the page loads, so an
 * inline script in index.html adds it first; this keeps the tag in step with
 * the selected network afterwards (a later change takes effect on reload).
 */
export function syncSmartAppBanner(doc: Document, network: string): void {
  const existing = doc.head.querySelector(`meta[name="${SMART_APP_BANNER_NAME}"]`);
  if (!shouldRecommendMobileApp(network)) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const meta = doc.createElement('meta');
  meta.name = SMART_APP_BANNER_NAME;
  meta.content = `app-id=${DASHPAY_IOS_APP_ID}`;
  doc.head.appendChild(meta);
}

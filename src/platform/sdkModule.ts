export type SdkModule = typeof import('@dashevo/evo-sdk');

let sdkModulePromise: Promise<SdkModule> | null = null;

export function loadSdkModule(): Promise<SdkModule> {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@dashevo/evo-sdk').catch((err) => {
      sdkModulePromise = null;
      throw err;
    });
  }
  return sdkModulePromise;
}

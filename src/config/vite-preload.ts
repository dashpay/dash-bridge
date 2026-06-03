const HEAVY_DASH_CHUNK_PATTERN = /evo-sdk|dapi-client|dashcore-lib|dapi-subscription/;

export function shouldPreloadDashChunk(dep: string): boolean {
  return !HEAVY_DASH_CHUNK_PATTERN.test(dep);
}

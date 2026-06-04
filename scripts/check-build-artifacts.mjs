import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard the Lighthouse fix: the initial page must not preload or statically
// import the heavy Dash SDK/DAPI chunks that are meant to stay lazy-loaded.
const distDir = new URL('../dist/', import.meta.url);
const indexPath = new URL('index.html', distDir);
// Single source of truth for heavy Dash chunk names; kept in sync with
// HEAVY_DASH_CHUNK_PATTERN in src/config/vite-preload.ts.
const HEAVY_CHUNK_NAMES = ['evo-sdk', 'dapi-client', 'dashcore-lib', 'dapi-subscription', 'islock'];
const CHUNK_ALTERNATION = HEAVY_CHUNK_NAMES.join('|');
const heavyChunkPattern = new RegExp(`(?:${CHUNK_ALTERNATION})`);

function fail(message) {
  console.error(`::error title=Build artifact smoke check failed::${message}`);
  console.error('\nBUILD ARTIFACT CHECK FAILED');
  console.error(message);
  console.error('');
  process.exit(1);
}

function readBuiltFile(path) {
  if (!existsSync(path)) {
    fail(`missing ${path}; run npm run build first`);
  }
  return readFileSync(path, 'utf8');
}

const html = readBuiltFile(indexPath);
const linkTags = html.match(/<link\b[^>]*>/g) ?? [];
const heavyPreloads = linkTags.filter((tag) => {
  const rel = tag.match(/\brel=["']([^"']+)["']/)?.[1] ?? '';
  const href = tag.match(/\bhref=["']([^"']+)["']/)?.[1] ?? '';
  return rel.split(/\s+/).includes('modulepreload') && heavyChunkPattern.test(href);
});

if (heavyPreloads.length > 0) {
  fail(`heavy modulepreload entries found: ${heavyPreloads.join(', ')}`);
}

const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
const entrySrc = scriptTags
  .map((tag) => ({
    type: tag.match(/\btype=["']([^"']+)["']/)?.[1],
    src: tag.match(/\bsrc=["']([^"']+)["']/)?.[1],
  }))
  .find((script) => script.type === 'module' && script.src)?.src;

if (!entrySrc) {
  fail('could not find module entry script in dist/index.html');
}

const entryRelativePath = entrySrc.replace(/^\//, '').replace(/^.*?(assets\/)/, '$1');
const entryPath = join(distDir.pathname, entryRelativePath);
const entryChunk = readBuiltFile(entryPath);
const heavySpecifier = `["'][^"']*(?:${CHUNK_ALTERNATION})[^"']*["']`;
const staticImportPattern = new RegExp(
  `\\bimport\\s*(?:${heavySpecifier}|[\\w*{}\\s,]+from\\s*${heavySpecifier})`
);

if (staticImportPattern.test(entryChunk)) {
  fail('entry chunk statically imports a heavy Dash chunk');
}

console.log('Build artifact smoke check passed');

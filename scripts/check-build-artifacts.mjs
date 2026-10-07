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

// The embeddable widget SDK (docs/widget.md) must ship, stay tiny, and never
// pull in the Dash SDK or other heavy dependencies.
const WIDGET_MAX_BYTES = 30 * 1024;
for (const name of ['widget.js', 'widget.mjs']) {
  const widget = readBuiltFile(new URL(name, distDir));
  const size = Buffer.byteLength(widget);
  if (size > WIDGET_MAX_BYTES) {
    fail(`dist/${name} is ${size} bytes; the widget SDK must stay under ${WIDGET_MAX_BYTES} bytes`);
  }
  if (/\bimport\s*[\w*{}\s,]*(?:from\s*)?["']|\bimport\s*\(|\brequire\(/.test(widget)) {
    fail(`dist/${name} must be self-contained (found an import/require)`);
  }
  if (name === 'widget.js' && !/^var DashBridge\b/.test(widget)) {
    fail('dist/widget.js must expose the global DashBridge');
  }
  // Login verification (secp256k1) belongs in widget-verify.mjs, not the SDK.
  if (widget.includes('DarkCoin Signed Message')) {
    fail(`dist/${name} must not bundle the login verifier; it ships as dist/widget-verify.mjs`);
  }
}

// "Sign in with Dash" verifier: self-contained ES module that apps import on
// their server. Check that it loads in Node and rejects a bogus result.
const VERIFY_MAX_BYTES = 64 * 1024;
const verifyUrl = new URL('widget-verify.mjs', distDir);
const verifySource = readBuiltFile(verifyUrl);
if (Buffer.byteLength(verifySource) > VERIFY_MAX_BYTES) {
  fail(`dist/widget-verify.mjs must stay under ${VERIFY_MAX_BYTES} bytes`);
}
if (/\bimport\s*[\w*{}\s,]*(?:from\s*)?["']|\bimport\s*\(|\brequire\(/.test(verifySource)) {
  fail('dist/widget-verify.mjs must be self-contained (found an import/require)');
}
const { verifyLogin } = await import(verifyUrl.href);
const bogus = verifyLogin({}, { expectedOrigin: 'https://app.example', expectedNonce: 'x'.repeat(16), network: 'testnet', identityPublicKeys: [] });
if (typeof verifyLogin !== 'function' || bogus?.ok !== false) {
  fail('dist/widget-verify.mjs does not export a working verifyLogin');
}

console.log('Build artifact smoke check passed');

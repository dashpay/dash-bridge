import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const distDir = new URL('../dist/', import.meta.url);
const indexPath = new URL('index.html', distDir);
const heavyChunkPattern = /(?:evo-sdk|dapi-client|dashcore-lib|dapi-subscription|islock)/;

function fail(message) {
  console.error(`Build artifact smoke check failed: ${message}`);
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
const staticImportPattern =
  /\bimport\s*(?:["'][^"']*(?:evo-sdk|dapi-client|dashcore-lib|dapi-subscription|islock)[^"']*["']|[\w*{}\s,]+from\s*["'][^"']*(?:evo-sdk|dapi-client|dashcore-lib|dapi-subscription|islock)[^"']*["'])/;

if (staticImportPattern.test(entryChunk)) {
  fail('entry chunk statically imports a heavy Dash chunk');
}

console.log('Build artifact smoke check passed');

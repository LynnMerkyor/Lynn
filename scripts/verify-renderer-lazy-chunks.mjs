import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const distDir = path.join(root, 'desktop', 'dist-renderer');
const assetsDir = path.join(distDir, 'assets');
const indexPath = path.join(distDir, 'index.html');
const forbidden = /(?:mermaid|wardley|rendering-vendor|katex-vendor|markdown-vendor|sanitize-vendor)/i;

function fail(message) {
  console.error(`[renderer-lazy-chunks] FAIL: ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(indexPath) || !fs.existsSync(assetsDir)) {
  fail('renderer output is missing; run npm run build:renderer first');
  process.exit();
}

const html = fs.readFileSync(indexPath, 'utf8');
const preloadTargets = [...html.matchAll(/<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/gi)]
  .map((match) => path.basename(match[1]));
const forbiddenPreloads = preloadTargets.filter((name) => forbidden.test(name));
if (forbiddenPreloads.length > 0) {
  fail(`on-demand renderer chunks are preloaded by index.html: ${forbiddenPreloads.join(', ')}`);
}

const scriptMatch = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i);
if (!scriptMatch) {
  fail('main module script was not found in index.html');
  process.exit();
}

const entry = path.basename(scriptMatch[1]);
const staticImportPattern = /\b(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?["']\.\/([^"']+)["']/g;
function collectStaticGraph(graphEntry) {
  const visited = new Set();
  const stack = [graphEntry];
  while (stack.length > 0) {
    const asset = stack.pop();
    if (!asset || visited.has(asset)) continue;
    visited.add(asset);
    const assetPath = path.join(assetsDir, asset);
    if (!fs.existsSync(assetPath)) continue;
    const source = fs.readFileSync(assetPath, 'utf8');
    for (const match of source.matchAll(staticImportPattern)) stack.push(path.basename(match[1]));
  }
  return visited;
}

const visited = collectStaticGraph(entry);

const forbiddenReachable = [...visited].filter((name) => forbidden.test(name));
if (forbiddenReachable.length > 0) {
  fail(`on-demand renderer chunks are statically reachable from ${entry}: ${forbiddenReachable.join(', ')}`);
}

const assets = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
const editorCore = assets.find((name) => name.startsWith('codemirror-vendor-'));
if (!editorCore || fs.statSync(path.join(assetsDir, editorCore)).size > 400_000) {
  fail('CodeMirror core exceeds 400KB or is missing; keep optional languages on demand');
}
if (editorCore && visited.has(editorCore)) fail('CodeMirror core must not be in the main entry static graph');
const editorEntry = assets.find((name) => name.startsWith('editor-window-'));
if (!editorEntry) fail('editor window entry is missing');
else {
  const editorGraph = collectStaticGraph(editorEntry);
  const bytes = [...editorGraph].reduce((sum, name) => sum + fs.statSync(path.join(assetsDir, name)).size, 0);
  if (bytes > 800_000) fail(`editor initial static graph exceeds 800KB: ${bytes} bytes`);
  console.log(`[renderer-lazy-chunks] editor initial graph: ${bytes} bytes (${editorGraph.size} chunks)`);
}
for (const required of ['mermaid.core', 'wardley', 'katex-vendor', 'markdown-vendor', 'sanitize-vendor']) {
  if (!assets.some((name) => name.includes(required))) fail(`expected lazy chunk not found: ${required}`);
}

const markdownEntry = assets.find((name) => /^markdown-[^-].*\.js$/.test(name));
if (!markdownEntry) {
  fail('markdown renderer entry chunk was not found');
} else {
  const markdownGraph = collectStaticGraph(markdownEntry);
  const katexReachable = [...markdownGraph].filter((name) => /katex-vendor/i.test(name));
  if (katexReachable.length > 0) {
    fail(`KaTeX is statically reachable from ordinary Markdown: ${katexReachable.join(', ')}`);
  }
}

const splitVendors = assets
  .filter((name) => /(?:katex-vendor|markdown-vendor|sanitize-vendor)/.test(name))
  .map((name) => ({ name, bytes: fs.statSync(path.join(assetsDir, name)).size }));
for (const chunk of splitVendors) {
  if (!chunk.name.includes('katex-vendor') && chunk.bytes > 500_000) {
    fail(`${chunk.name} remains above 500KB (${chunk.bytes} bytes)`);
  }
}

if (!process.exitCode) {
  console.log(`[renderer-lazy-chunks] PASS: ${entry} reaches ${visited.size} static chunks; heavy renderers remain on demand`);
  console.log(`[renderer-lazy-chunks] split vendors: ${splitVendors.map((item) => `${item.name}=${item.bytes}`).join(', ')}`);
}

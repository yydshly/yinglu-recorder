import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// Validate the published entry points without executing media fixtures or fetching external sites.
const root = path.resolve(import.meta.dirname, '..');
const pages = ['index.html', 'docs/index.html', 'docs/testing.html'];
let links = 0;
const errors = [];
for (const page of pages) {
  const filename = path.join(root, page);
  const html = await readFile(filename, 'utf8');
  for (const match of html.matchAll(/\b(?:href|src|poster)\s*=\s*["']([^"']+)["']/gi)) {
    const reference = match[1].replaceAll('&amp;', '&');
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) continue;
    try {
      const url = new URL(reference, `https://local.invalid/${page}`);
      const target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('outside project');
      const info = await stat(target);
      if (!info.isFile()) throw Error('not a file');
      if (url.hash && target.endsWith('.html')) {
        const content = target === filename ? html : await readFile(target, 'utf8');
        const ids = [...content.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
        if (!ids.includes(decodeURIComponent(url.hash.slice(1)))) throw Error('missing fragment');
      }
      links++;
    } catch (error) {
      errors.push(`${page}: ${reference} (${error.message})`);
    }
  }
  console.log(`Checked ${page}`);
}
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) errors.push('Package / manifest version mismatch');
for (const page of pages) {
  if (!(await readFile(path.join(root, page), 'utf8')).includes(`v${manifest.version}`)) errors.push(`${page}: missing current version`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`${links} local references and current version OK`);

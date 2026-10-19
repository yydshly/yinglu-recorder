import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isDirectory() && ['.git', 'node_modules', '.cache', '.tmp', 'coverage', 'test-results', 'playwright-report'].includes(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) await walk(full);
    else if (/\.(m?js)$/.test(item.name)) { execFileSync(process.execPath, ['--check', full]); console.log('OK', path.relative(root, full)); }
  }
}
await walk(root);
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
for (const entry of [manifest.background.service_worker, manifest.side_panel.default_path, ...Object.values(manifest.icons)]) await readFile(path.join(root, entry));
console.log('Manifest references OK');

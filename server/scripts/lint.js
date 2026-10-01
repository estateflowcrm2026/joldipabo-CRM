// Syntax-check every JS file under src/.
// Runs via `npm run lint`. Pure `node --check`; no ESLint dependency.

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)), 'src');

function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = collect(root);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch {
    console.error(`SYNTAX ERROR: ${f}`);
    failed += 1;
  }
}
console.log(`lint: checked ${files.length} files, ${failed} failed.`);
process.exit(failed ? 1 : 0);

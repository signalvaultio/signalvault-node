// Clean build: compile the CommonJS output, then add the ESM entry point.
import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

rmSync('dist', { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc], { stdio: 'inherit' });
for (const file of ['index.mjs', 'index.d.mts']) {
  copyFileSync(`src/esm/${file}`, `dist/${file}`);
}

/**
 * Build Nest léger pour Render (évite le OOM du nest CLI sur 512 MiB).
 * Utilise tsc sans declarations / source maps, puis copie les assets mail.
 */
const { rmSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const dist = join(process.cwd(), 'dist');
if (existsSync(dist)) {
  rmSync(dist, { recursive: true, force: true });
}
for (const info of ['tsconfig.tsbuildinfo', 'tsconfig.build.tsbuildinfo', 'tsconfig.build.prod.tsbuildinfo']) {
  const p = join(process.cwd(), info);
  if (existsSync(p)) rmSync(p, { force: true });
}

const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
const build = spawnSync(
  process.execPath,
  ['--max-old-space-size=384', tsc, '-p', 'tsconfig.build.prod.json'],
  { stdio: 'inherit', env: process.env },
);

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const assets = spawnSync(process.execPath, [join('scripts', 'copy-mail-assets.cjs')], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(assets.status ?? 0);

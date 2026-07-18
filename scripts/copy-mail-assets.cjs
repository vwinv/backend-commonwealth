/**
 * Copie les assets mail (logo, etc.) vers dist/ après tsc.
 * Nest CLI le faisait via nest-cli.json ; le build prod utilise tsc seul.
 */
const { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

function copyDir(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

copyDir(join('src', 'mail', 'assets'), join('dist', 'mail', 'assets'));

/**
 * Démarre le backend en prod (Render / Docker).
 * Si le build Nest n’a pas été exécuté (Build Command manquant), le lance ici.
 */
const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const candidates = ['dist/main.js', 'dist/src/main.js'];

function resolveMain() {
  for (const rel of candidates) {
    const abs = path.join(process.cwd(), rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

let main = resolveMain();
if (!main) {
  console.log('[start-prod] dist/main.js introuvable — exécution de npm run build…');
  const build = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
  main = resolveMain();
}

if (!main) {
  console.error(
    '[start-prod] Build terminé mais aucun point d’entrée trouvé (attendu: dist/main.js).',
  );
  process.exit(1);
}

console.log(`[start-prod] Démarrage: ${path.relative(process.cwd(), main)}`);
const run = spawnSync(process.execPath, [main], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(run.status ?? 1);

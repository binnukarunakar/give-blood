// Proves the demo cannot ship: builds the client with VITE_DEMO_MODE unset and
// fails if any emitted asset still contains a demo marker.
//
// The guarantee is otherwise only a comment in src/demo/demoMode.ts. This makes
// it a command. No dependencies — node and the existing build script only.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(CLIENT_DIR, 'dist-verify');

/** A persona token and a demo-only class: neither can reach a production bundle. */
const MARKERS = ['demo-asha', 'demo-bar'];

function build() {
  // VITE_DEMO_MODE is deleted, not set to 0: an inherited value from the shell
  // that just ran the demo build would otherwise make this check vacuous.
  const env = { ...process.env };
  delete env.VITE_DEMO_MODE;
  const result = spawnSync(
    'npm',
    ['run', 'build', '--', '--outDir', OUT_DIR, '--emptyOutDir'],
    { cwd: CLIENT_DIR, env, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.status !== 0) {
    console.error('verify:no-demo — production build failed');
    process.exit(1);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function scan() {
  const hits = [];
  for (const file of walk(OUT_DIR)) {
    const text = readFileSync(file, 'utf8');
    for (const marker of MARKERS) {
      if (text.includes(marker)) hits.push(`${relative(OUT_DIR, file)}: ${marker}`);
    }
  }
  return hits;
}

build();
let hits;
try {
  hits = scan();
} finally {
  rmSync(OUT_DIR, { recursive: true, force: true });
}

if (hits.length > 0) {
  console.error('verify:no-demo FAILED — demo code reached the production bundle:');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.error(`verify:no-demo OK — no ${MARKERS.join(' / ')} in the production assets`);

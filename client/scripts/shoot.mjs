// Screenshot rig (GB-28). Captures every named route at both review sizes so
// the lead reviews images, not descriptions (docs/DESIGN.md § QA protocol).
//
// It boots nothing: the demo server must already be running.
//   cd server && npm run demo          # serves client/dist on :8787
//   cd client && npm run shoot -- --ticket gb-28 --persona asha /donor
//
// Args: any number of paths, plus
//   --persona <asha|ravi|meera|city>  seeds the demo persona before load
//   --ticket  <id>                    nests output under screenshots/<id>/
//   --base    <url>                   default http://localhost:8787
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const CLIENT_DIR = fileURLToPath(new URL('..', import.meta.url));
const PERSONA_STORAGE_KEY = 'give-blood.demo.persona';
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

function parseArgs(argv) {
  const options = { base: 'http://localhost:8787', persona: null, ticket: null, paths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--persona' || arg === '--ticket' || arg === '--base') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag ${arg}`);
    } else {
      options.paths.push(arg.startsWith('/') ? arg : `/${arg}`);
    }
  }
  if (options.paths.length === 0) throw new Error('Give at least one path, e.g. /donor');
  return options;
}

/** '/requester/requests/abc' -> 'requester-requests-abc'; '/' -> 'root'. */
function slug(routePath) {
  const cleaned = routePath.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-');
  return cleaned === '' ? 'root' : cleaned.toLowerCase();
}

async function requireServer(base) {
  try {
    const response = await fetch(base, { redirect: 'manual' });
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
  } catch (cause) {
    throw new Error(
      `No demo server on ${base} (${cause.message}). Start it first:\n` +
        '  cd server && npm run demo\n' +
        'and build the client it serves: VITE_DEMO_MODE=1 npm run build',
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await requireServer(options.base);

  const browser = await chromium.launch();
  try {
    for (const routePath of options.paths) {
      const outDir = path.join(
        CLIENT_DIR,
        'screenshots',
        ...(options.ticket === null ? [] : [options.ticket]),
        slug(routePath),
      );
      await mkdir(outDir, { recursive: true });

      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 2,
          colorScheme: 'dark',
          reducedMotion: 'reduce',
        });
        if (options.persona !== null) {
          await context.addInitScript(
            ([key, value]) => window.localStorage.setItem(key, value),
            [PERSONA_STORAGE_KEY, options.persona],
          );
        }
        const page = await context.newPage();
        await page.goto(`${options.base}${routePath}`, { waitUntil: 'networkidle' });
        const file = path.join(outDir, `${viewport.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        await context.close();
        console.error(path.relative(CLIENT_DIR, file));
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

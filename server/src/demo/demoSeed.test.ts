// The demo's own regression guard (GB-24).
//
// Two things must stay true or the demo is worthless:
//   1. the seeded donors are actually in the matching pool, and the matcher
//      separates them the way the personas promise (group gate, radius tier);
//   2. nothing in production imports src/demo/ — the demo is one-directional.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eligibleDonors, type EligibleDonor } from '../matching/eligibility.js';
import {
  DEMO_HOSPITAL,
  handleForPushToken,
  verifyDemoGeometry,
} from './demoPersonas.js';
import { createDemoDb, seedDemo } from './demoSeed.js';

/** Pinned clock. 16:00Z = noon in America/New_York — nowhere near quiet hours. */
const NOW = new Date('2026-07-15T16:00:00Z');

let db: PGlite;

beforeAll(async () => {
  db = await createDemoDb();
  await seedDemo(db, NOW);
});

afterAll(async () => {
  await db.close();
});

/** Who the matcher returned, by persona handle — push tokens are never displayed. */
function handlesOf(donors: EligibleDonor[]): string[] {
  return donors.map((d) => handleForPushToken(d.pushToken)).sort();
}

function eligibleAtTier(tierIdx: 0 | 1 | 2): Promise<EligibleDonor[]> {
  return eligibleDonors(db, {
    bloodGroup: 'B+',
    hospitalLat: DEMO_HOSPITAL.lat,
    hospitalLng: DEMO_HOSPITAL.lng,
    tierIdx,
    urgency: 'critical',
    requestId: null,
    now: NOW,
  });
}

describe('demo seed', () => {
  it('keeps the fixture geometry intact', () => {
    expect(verifyDemoGeometry()).toEqual([]);
  });

  it('puts Asha in the tier-0 pool and leaves the A+ donor out', async () => {
    const matched = await eligibleAtTier(0);
    // Asha alone: Meera is 'closer' but A+ (incompatible with a B+ request),
    // and Ravi is compatible but outside the 5 km cover.
    expect(handlesOf(matched)).toEqual(['Asha']);
  });

  it('adds Ravi at tier 1 — the escalation the demo shows', async () => {
    const matched = await eligibleAtTier(1);
    expect(handlesOf(matched)).toEqual(['Asha', 'Ravi']);
  });

  it('never matches the A+ donor for a B+ request, at any tier', async () => {
    for (const tier of [0, 1, 2] as const) {
      expect(handlesOf(await eligibleAtTier(tier))).not.toContain('Meera');
    }
  });
});

// ── The one-directional rule ─────────────────────────────────────────────────

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

/** Every module specifier a file imports: static, side-effect, or dynamic. */
function importedSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+'([^']+)'/g,
    /\bimport\s*\(\s*'([^']+)'\s*\)/g,
    /\bimport\s+'([^']+)'/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec !== undefined) found.push(spec);
    }
  }
  return found;
}

describe('demo isolation', () => {
  it('is imported by no production module', () => {
    const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
      .map((name) => name.replaceAll('\\', '/'))
      .filter((name) => name.endsWith('.ts') && !name.startsWith('demo/'));

    // Sanity: the walk actually found the production tree.
    expect(files).toContain('index.ts');
    expect(files).toContain('app.ts');

    const offenders = files.filter((name) =>
      importedSpecifiers(readFileSync(path.join(SRC_DIR, name), 'utf8')).some((spec) =>
        spec.includes('demo/'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

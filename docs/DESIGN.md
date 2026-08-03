# DESIGN — Give Blood UI system

Authored by the lead (Fable), 2026-08-02. This is the canonical UI
architecture: implementing agents follow it exactly; deviations are declared
on the ticket like any other spec. Governing taste: Linear/Vercel-grade
restraint — reduction over addition, one hierarchy per view, motion only when
it communicates. Pairs with the vibe-code UI rules (no emojis, no gradients,
loading/error/empty states everywhere) — where this doc and vibe rules seem
to conflict, vibe rules win (so: **no gradients at all**, including mesh).

## Direction

**Clinical dark.** Dark-first zinc palette, `color-scheme: dark`. A blood app
must feel calm and certain, not alarming: near-black surfaces, quiet borders,
white primary actions. **Red is semantic only** — blood-group identity,
`critical` urgency, destructive confirmations. Red never decorates. Tokens
are structured so a light theme is one `[data-theme]` block later.

Font: system stack (`-apple-system, system-ui, 'Segoe UI', Roboto, Inter,
sans-serif`). The PWA ships no network fonts (offline-first, CSP-clean) —
declared deviation from the Geist default; weight/size discipline does the
work instead.

## Tokens (`src/tokens.css` — replaces the token block of styles.css)

```css
:root {
  color-scheme: dark;
  /* primitives */
  --zinc-950:#09090b; --zinc-900:#18181b; --zinc-850:#1f1f23;
  --zinc-800:#27272a; --zinc-700:#3f3f46; --zinc-500:#71717a;
  --zinc-400:#a1a1aa; --zinc-200:#e4e4e7; --zinc-50:#fafafa;
  --red-500:#ef4444; --red-400:#f87171; --red-950:#450a0a;
  --green-400:#4ade80; --amber-400:#fbbf24;
  /* semantic — components use ONLY these */
  --bg:var(--zinc-950); --surface:var(--zinc-900); --surface-2:var(--zinc-850);
  --border:rgba(255,255,255,0.08); --border-strong:rgba(255,255,255,0.14);
  --text:var(--zinc-50); --muted:var(--zinc-400); --subtle:var(--zinc-500);
  --accent:#ffffff; --accent-text:var(--zinc-950);
  --blood:var(--red-500); --blood-soft:rgba(239,68,68,0.12);
  --ok:var(--green-400); --warn:var(--amber-400); --danger:var(--red-400);
  /* spacing (4-grid) */
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:20px; --s6:24px;
  --s8:32px; --s10:40px; --s12:48px; --s16:64px;
  /* type */
  --t-xs:12px; --t-sm:13px; --t-base:15px; --t-lg:17px; --t-xl:20px;
  --t-2xl:24px; --t-3xl:32px; --t-display:44px;
  /* radius: controls 8, cards 12, sheets 16, pills 9999 */
  --r-ctl:8px; --r-card:12px; --r-sheet:16px; --r-pill:9999px;
  /* motion */
  --ease:cubic-bezier(0.16,1,0.3,1); --dur-fast:150ms; --dur:250ms;
}
```

Global: antialiased text; body `--t-base`/1.55; headings `letter-spacing:
-0.01em` and tight leading; `:focus-visible { outline:2px solid
rgba(255,255,255,0.4); outline-offset:2px }` (never removed); full
`prefers-reduced-motion` kill switch; 44px minimum touch targets.

## Primitives (`src/ui/` — Button, Card, Chip, Field, Switch, Banner, Skeleton, EmptyState, StickyBar, StatChip)

- **Button** — variants: `primary` (white bg, dark text, hover zinc-100,
  active scale .98), `secondary` (surface-2 bg, border, text), `ghost`
  (transparent, muted → text on hover), `danger` (transparent, `--danger`
  text, border `--danger` at 25% — destructive is quiet, never a red slab).
  Sizes: default 40px, `lg` 48px (alert actions). Full-width prop. Loading
  state = inline spinner replacing label, width preserved. Disabled 50%.
- **BloodChip** — THE identity element. Monospace-weight blood group in a
  `--blood-soft` pill with `--blood` text + 1px `--blood` 25% border. Sizes:
  `sm` (13px, list rows), `md` (17px), `display` (44px, alert detail — the
  biggest thing on that screen).
- **Card** — `--surface`, 1px `--border`, `--r-card`, padding `--s5`.
  Never nested. Section title inside: 13px semibold `--muted` uppercase
  tracking +0.04em.
- **Field** — label (13px medium, `--text`) above control; inputs 44px,
  `--surface-2` bg, border `--border-strong`, focus ring; helper 13px
  `--subtle`; error 13px `--danger` + border swap. Placeholder never a label.
- **Switch** — 40×24 track (`--zinc-700` off, `--accent` on with dark thumb),
  150ms; label + one-line description left, switch right; row min 44px.
- **SegmentedControl** — urgency picker: 2 equal segments in a `--surface-2`
  track; selected segment `--surface` + border; `critical` selected adds
  `--blood` left dot, not a red fill.
- **StatusChip** — request/pledge states: 6px dot + 12px medium label in a
  quiet pill. Colors: open/alerting `--warn` dot, partially_pledged/covered
  `--ok` dot, fulfilled `--ok` dot + label, expired/cancelled `--subtle`,
  active pledge `--ok`, no_show/withdrawn `--subtle`, donated `--ok`.
- **Banner** — info (surface-2), warn (`--warn` 10% bg), error (`--blood-soft`
  bg): 13px, icon-free, actionable copy only.
- **Skeleton** — `--surface-2` blocks, 1.4s opacity pulse; every fetch >150ms
  renders skeletons shaped like the loaded layout (no spinners on full pages).
- **EmptyState** — centered, 15px `--muted` line + one specific CTA.
- **StickyBar** — mobile action bar: fixed bottom, `--bg` at 92% +
  `backdrop-blur(12px)`, top border, padding `--s4`, safe-area inset.
- **StatChip row** — label-over-number stat (11px uppercase `--subtle` /
  20px semibold `--text`), used on requester cards/detail.

## App shell

Sticky header 56px: `--bg` 85% + `backdrop-blur(12px)`, bottom `--border`.
Left: brand — an 18px SVG drop mark in `--blood` + "Give Blood" 15px
semibold (the only place the mark appears). Center/right: role nav as two
ghost tabs (active = `--text` + 2px underline in `--accent`), sign-out ghost
icon-button with aria-label. Content column `max-width:640px`, padding
`--s4` mobile / `--s6` ≥768px. Page pattern: h1 20px semibold + optional
13px `--muted` subline, then `--s6` gap to content; sections gap `--s8`.
Route mount: fade + 4px rise, `--dur` `--ease`, CSS only (no framer-motion —
bundle discipline; declared deviation).

## Screens

**Login** — centered single Card (max-w 360) at 25vh: brand mark 32px, "Sign
in to Give Blood" 20px, one-line purpose copy 13px `--muted`, phone Field,
primary full-width "Send code", then code Field + "Verify" on step 2.

**Donor onboarding** — one column, numbered section Cards (01 Identity —
handle Field + blood-group grid: 8 tiles 2×4, 56px tall, group 17px
semibold, selected = `--blood` border + `--blood-soft` bg, others quiet;
02 Consent — one Switch row with exact consent copy; 03 Area — map Card
(or manual entry fallback) + one line "Stored as a ~5 km cell — your exact
location never leaves this phone" 13px `--subtle`). Sticky primary
"Create donor profile" enabled only when valid. Push step: full-screen
state card — icon-free, 20px "Prove this phone can hear alerts", steps as
quiet numbered lines, primary CTA per state, `pushVerified` success state
with `--ok` check line.

**Donor home** — Identity Card: BloodChip `md` + handle 20px semibold row;
meta line 13px `--muted` (area cell · member since); verified state as
StatusChip. Below: "Alerts" Card = Switch rows (available / snooze
quick-rows / share phone / consent — consent visually separated by divider +
13px explanation). "Donation" Card: last donation + eligible-again line,
ghost "I donated today" → confirm dialog (danger-quiet confirm pattern:
sheet with title, one-line consequence, ghost cancel + primary confirm).

**Alert detail** — the product's one shot. Vertical hierarchy, no card
chrome at top level:
1. StatusChip row: urgency (critical = `--blood` dot + "Critical") +
   "expires in Xh" 13px `--muted`.
2. BloodChip `display` + "N units" 17px — the visual center.
3. Hospital block (Card): name 17px semibold, address 13px `--muted`,
   distance line "~X km from your area", map pin (or address-only), and
   secondary full-width "Call blood bank to confirm" (tel:).
4. StickyBar: Accept `lg` primary full-width; Decline as ghost beneath it.
   Accept expands eta segmented row (3 buckets) + share-phone Switch inline
   before confirm.
Closed/fulfilled/cancelled: full-screen calm state — 20px "This request has
been fulfilled", 15px `--muted` thanks line, ghost "Back". Pledged state:
Card with `--ok` StatusChip "You pledged", eta line, primary "Directions",
secondary tel:, `danger` ghost "Withdraw pledge" bottom-right.

**Requester home** — header row: h1 + primary "New request". Request Cards:
top row BloodChip `sm` + units 15px + StatusChip right; StatChip row
(alerted / pledged / confirmed); footer 13px `--subtle` hospital · created.
Empty state per EmptyState. 403 screen: calm explanation card.

**New request** — one Card: hospital-id Field (helper copy re operator),
blood-group grid (reuse), units stepper (44px buttons, 20px count),
urgency SegmentedControl. Banners for warning/duplicate (with
"different patient" re-submit as secondary). Primary full-width "Send
alert to donors" — the copy says what it does.

**Request detail** — facts header (BloodChip `md`, units, urgency chip,
StatusChip, hospital line), StatChip row, live line: 8px `--ok` pulsing dot
+ "Live — updates every 12 s" 12px `--subtle` (pulse only while polling;
reduced-motion → static). Pledge Cards: handle 15px semibold + BloodChip
`sm` + eta + tel: ghost when shared; per-card secondary "Donated" +
ghost "No-show" (both confirm). Terminal banners via Banner. Cancel:
`danger` ghost at the very bottom, never near primary actions.

**Demo chrome** (demo build only) — persona strip UNDER the header: 40px,
`--surface` bg, bottom border; 12px uppercase `--subtle` "Demo" prefix;
personas as 4 pill toggles (active = `--accent` text + border-strong);
right: ghost 12px buttons Sweep / Expire / Reset. Push inbox: bottom-right
floating Card 320px max (mobile: full-width bottom sheet), 13px "Push inbox
— what each phone would receive", entries as quiet mono 12px rows, newest
first, badge count on collapsed pill.

Pill collision law (evolved through GB-31a/33b/33c — this is canonical):
the pill rides ABOVE any `.sticky-bar` (live-measured offset + 8px), hides
while a confirm sheet is open, and on geometric overlap with any interactive
control it RELOCATES (8px upward steps to a clear position, max 40% viewport)
before ever ghosting; ghost (opacity .35, pointer-events none) is the last
resort only when no clear position exists. Amendments from build reality:
persona pills are 44px touch targets (strip 52px, not 40); route transitions
are fade-only (any transform breaks position:fixed descendants); ConfirmSheet
is role=alertdialog with a real focus trap + Escape.

## QA protocol for every UI ticket

1. AC chain green (typecheck/lint/test/build) — existing tests updated ONLY
   where copy/structure legitimately changed; roles/labels preserved.
2. Playwright screenshot set at 390×844 AND 1280×800 against the demo server
   for every changed screen state, saved to `client/screenshots/<ticket>/`
   (gitignored), path list in the report. The lead reviews the images.
3. Squint test self-check in the report: name the ONE most prominent element
   per screen — it must be the primary action or identity element.

## Anti-patterns (hard)

No emojis anywhere. No gradients (incl. mesh). No colored shadows; no
box-shadow depth — borders + surface steps only. No red fills on large
surfaces (red = chips/dots/text only). No `rounded-full` cards. No spinners
where skeletons belong. No two same-weight actions side by side. No
arbitrary spacing off the 4-grid. Icons: inline SVG only, 16/20px, mono
`--muted` (no icon libraries — we need ~6 icons total: drop mark, check,
chevron, close, phone, pin).

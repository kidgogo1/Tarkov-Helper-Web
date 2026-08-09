# Spec: Tarkov Helper Web

## Objective

Build a Korean-first, responsive web port of the user-facing Tarkov Helper app from:

- Original baseline: `Zeliper/Tarkov-Item-Helper` at `ef71936`
- Modified priority fork: `SIGDrone/Tarkov-Helper` at `77ee734` (`v1.5.7`)

The modified fork wins where behavior conflicts. Its PVP/PVE profiles, fixed-view map, custom markers, Terminal map, and Korean UI are required. Known fork defects are not compatibility requirements.

## Tech Stack

- React + TypeScript + Vite
- Static JSON exported from the modified fork's bundled SQLite database
- Bundled SVG maps and local PNG/SVG/WebP icons
- Browser `localStorage` for independent PVP/PVE progress and shared settings
- Vitest for domain tests and Playwright for critical browser flows
- Static/offline core with an optional loopback-only Windows Direct price bridge

## Commands

- Install: `pnpm install`
- Export bundled data/assets: `pnpm data:export`
- Refresh the generated PVP/PVE price catalog: `pnpm data:refresh-prices`
- Develop: `pnpm dev --host 127.0.0.1`
- Test: `pnpm test --run`
- Type-check: `pnpm typecheck`
- Lint: `pnpm lint`
- Build: `pnpm build`
- Browser tests: `pnpm test:e2e`

## Project Structure

- `src/app` — shell, routing, persistent application state
- `src/components` — reusable controls, drawers, dialogs, list/detail layout
- `src/features` — quests, hideout, items, collector, prices, map, settings
- `src/domain` — status, aggregation, recommendations, log/screenshot parsing, map transforms
- `src/types` — exported-data and state contracts
- `src/styles` — tokens, base styles, responsive layout
- `public/data` — generated static JSON
- `public/assets` — copied maps and icons. The bundled font is not redistributed;
  users may select an installed browser-safe font or load their own font for the session.
- `scripts` — deterministic SQLite/assets exporter
- `tests` — cross-feature tests
- `e2e` — critical real-browser flows

## Code Style

Use explicit domain functions and focused components. Prefer immutable inputs and testable outputs.

```ts
export function getQuestStatus(
  quest: Quest,
  context: QuestStatusContext,
): QuestStatus {
  const saved = context.progress[quest.id];
  if (saved === "done" || saved === "failed") return saved;
  return meetsAvailabilityRules(quest, context) ? "active" : "locked";
}
```

Use semantic HTML, accessible names for icon buttons, Korean visible copy, and a consistent dark/gold design token system matching the reference screenshots.

## Testing Strategy

- Unit tests: quest availability/prerequisites, automatic prerequisite completion, alternative failure, item aggregation/FIR fulfillment, collector chain, screenshot/log parsing, coordinate transforms.
- Component tests where behavior cannot be proven by pure functions.
- Real-browser tests: profile isolation, quest completion, item inventory, hideout level, custom marker, screenshot-position trail, responsive navigation.
- Manual visual checks at 320, 768, 1024, and 1440 CSS pixels with a clean browser console.

## Boundaries

- Always: preserve PVP/PVE isolation; persist user changes; keep keyboard access; run tests and build. Core quest/map data remains repository-bundled; price data uses only the fixed Tarkov.dev JSON source described by ADR-003.
- Ask first: deployment, adding a backend, introducing accounts/cloud sync, or replacing repository data with a third-party source.
- Never: dynamically scrape arbitrary Tarkov sites, accept a user-provided upstream URL, send progress/settings to price services, ship secrets, or reproduce known migration/profile bugs from the modified fork.

## Functional Requirements

### Global and profiles

- Korean UI with Korean primary names and English subtitles where present.
- PVP and PVE profiles independently store level, faction, edition flags, prestige, DSP decode count, Scav reputation, quest/goal progress, hideout levels, inventory, and custom markers.
- Shared font size/family and map display preferences.
- Reset requires confirmation and affects only the current profile.

### Quests

- Load all 488 bundled quests.
- Search and filter by Kappa, item requirement, trader, map, computed status, and faction.
- Compute unavailable/locked/level-locked/active/done/failed from the same requirements as the desktop service.
- Complete/reset quests, recursively complete safe prerequisites, and fail mutually exclusive alternatives.
- Show requirements, required items with inventory fulfillment, objectives with checkboxes, prerequisite OR groups, alternatives, follow-ups, Kappa progress, wiki link, and map handoff.
- Show five smart recommendations using the fork's priority rules.

### Hideout

- Load all 26 stations; search; change station level; show next-level and all-remaining requirements.
- Show item, trader, skill, and station prerequisites with inventory fulfillment.

### Items and Collector

- Aggregate unfinished quest and remaining hideout requirements.
- Track FIR and non-FIR inventory separately; FIR can satisfy general total requirements while FIR-only requirements use FIR quantity.
- Search/filter/sort and show contributing quests/hideout levels.
- Collector page supports prerequisite inclusion, fulfillment filters, Kappa source badges, and the same inventory.

### Prices

- Search the generated catalog by Korean, English, short, and normalized item names without a request per keystroke.
- Follow the active PVP/PVE profile and always show the bundled release-time snapshot as an offline fallback.
- In Windows Direct only, request a selected item's bounded live history through the same-origin launcher endpoint; reject cross-site requests, redirects, proxies, arbitrary URLs, malformed data, and oversized bodies.
- Show source/update time, flea low/average/range/change/offer count, and the bundled best trader sale. Price data is advisory.

### Map

- Load all 12 bundled SVG maps including Terminal.
- Pan, pointer-centered zoom, reset view, fixed view, full-screen mode, floor selection, and floor-aware visibility.
- Toggle quest objectives, PMC/Scav/transit extracts, PMC spawns, sniper Scavs, Rogues, Cultists, levers, and bosses.
- Show active quest objective list, completion progress, type/status/group filters, marker selection, and cross-navigation from quests.
- Add/edit/delete profile-specific custom markers with name, eight colors, size 12–64, floor, and global list opacity.
- Parse repository-defined EFT screenshot filenames into player position/direction; draw/clear a trail; switch floor from height ranges.

### Log and browser substitutions

- Parse user-selected EFT log files/folders for quest started/completed/failed events and map detection, then preview and apply changes.
- The browser cannot silently watch arbitrary OS folders, register global hotkeys, or create an always-on-top game overlay. Use explicit file/folder permission, in-page keyboard controls, and page/fullscreen mini-map display to preserve the same user outcomes.
- Program updates use the signed GitHub release flow. The independent price bridge contacts only the fixed Tarkov.dev endpoint and never receives progress or settings.

## Success Criteria

- Dataset counts and source commit IDs are visible in-app.
- All core flows work offline; the static price snapshot remains usable when the optional live endpoint is unavailable.
- Refreshing the page preserves state; switching profiles proves isolation.
- Unit, type-check, lint, build, and critical browser tests pass.
- No console errors/warnings, no horizontal overflow at required breakpoints, and all controls are keyboard reachable.

## Open Questions

None blocking. Deployment is intentionally outside this request.

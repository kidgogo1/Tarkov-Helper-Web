# Implementation Plan: Tarkov Helper Web

## Architecture Decisions

- Use a client-only SPA because all source data is bundled and user state is local.
- Export source SQLite and assets deterministically so the port remains traceable to the supplied repositories.
- Put behavior in pure domain modules before UI components so desktop rules can be regression-tested.
- Split page data loading and rendering, while sharing one profile store across all tabs.

## Phase 1: Foundation

- [ ] Scaffold Vite/React/TypeScript, design tokens, app types, and persistence store.
  - Acceptance: app shell starts and PVP/PVE state survives refresh independently.
  - Verify: store tests, type-check, build.
- [ ] Export SQLite data, maps, marker icons, required-item icons, and hideout icons.
  - Acceptance: generated JSON contains 488 quests, 26 stations, 12 maps, and the
    exact base-marker count discovered in the packaged database (454 in the reference commit).
  - Verify: exporter assertions and asset-count report.

## Checkpoint: Foundation

- [ ] Tests pass and data-backed shell renders.

## Phase 2: Core Feature Slices

- [ ] Implement and test quest status/progress/recommendations, then the quest page.
- [ ] Implement and test hideout progress, then the hideout page.
- [ ] Implement and test inventory aggregation/FIR fulfillment, then items and Collector pages.

Each slice must support profile switching and leave build/tests green.

## Checkpoint: Trackers

- [ ] Quest → item → hideout state changes propagate end-to-end.

## Phase 3: Map and Imports

- [ ] Implement/test coordinate transforms, screenshot parser, and log parser.
- [ ] Build SVG viewer, floor filtering, pan/zoom/fullscreen/fixed view, trail, and marker toggles.
- [ ] Add quest-objective interaction and persistent custom-marker CRUD.
- [ ] Add log/screenshot file import and preview/apply flow.

## Phase 4: Polish and Verification

- [ ] Complete responsive/mobile layouts, drawers, empty/error/loading states, keyboard focus, and reduced-motion behavior.
- [ ] Run unit/type/lint/build checks and critical Playwright flows.
- [ ] Review correctness, readability, architecture, security, and performance; resolve required findings.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Windows case/path conflicts in source assets | High | Read Git objects/known DB directly and copy only referenced assets with canonical lowercase output paths. |
| Thousands of rows/markers | Medium | Lazy page derivation, memoized selectors, list windowing/pagination where useful, and split map data. |
| Desktop-only OS integrations | High | Explicit browser file/folder permission and fullscreen/in-page equivalents, documented in UI. |
| Fork profile/objective persistence bugs | High | One versioned store keyed by profile and profile-isolation tests. |
| SVG floor/layer variation | Medium | Apply floor IDs from repository config and degrade to full-map display when a layer is absent. |

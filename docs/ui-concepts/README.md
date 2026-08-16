# Labline UI concept references

## Approved visual references

- [`labline-ui-streamline-desktop.png`](./labline-ui-streamline-desktop.png)
- [`labline-ui-streamline-mobile.png`](./labline-ui-streamline-mobile.png)

The desktop reference establishes a near-black map stage, a calm compact top
command bar, a grouped one-level rail, one active work surface, contextual Intel,
and a full-width live operational strip. The mobile reference keeps that order in
a compact header, one panel title, one activity row above the bottom nav, and
Build / Models / Plans / Data / More navigation.

The references establish composition, density, palette, and hierarchy only. They
do not define game rules, simulation data, routes, PanelIds, hotkeys, saves,
callbacks, or exact DOM structure.

## Generation intent

“Dark frontier strategy-game operations console; near-black world map; calm
compact top bar; grouped left rail; one active workbench; thin multi-job status
strip; mint positive state; amber training/attention state; restrained translucent
surfaces; mobile command shell; no duplicate headings or dashboard card walls.”

Use this as a short visual prompt, not as implementation source. For any future
generated example, record the intended zones, tokens, states, and motion beside
the image. Implement accepted decisions in React/CSS with live selectors,
accessible labels, keyboard behavior, and responsive layout. Never ship raster UI
or copy coordinates from pixels.

## Implemented interpretation

- Desktop groups are Operate, Build, Products, and Company; group headings live
  only in the rail.
- The active work surface owns one visible title and at most one single-level
  local view selector. No tabs-within-tabs or redundant desktop group banner.
- Mobile primary actions are Build, Models, Plans, Data; the focus-managed More
  sheet contains the remaining panels and Intel/Objectives/Destroy utilities.
- `HudPrimitives.tsx` and `kit.tsx` provide the shared button, card, tab, meter,
  state, input, select, range, metric, blocker, and layout contracts.
- `financeDashboardModel.ts`, `benchmarkViewModel.ts`, and
  `trainingJobViewModel.ts` own shared finance, public/private benchmark, and
  training projections. The Models queue and Define → Data → Compute → Review
  stepper consume the training projection; the global activity strip is a
  compact action pointer.
- Line/loss/donut/radar chart surfaces support hover, click/tap pin and unpin,
  keyboard navigation, and text/live readouts. Direct manipulation in the radar,
  map, and research canvas remains a deliberate exception with labelled detail
  paths.

The complete ownership, migration, responsive, and non-regression contract is in
[`../ui-revamp-design-system.md`](../ui-revamp-design-system.md) and
[`../UI_STREAMLINE_IMPLEMENTATION_PLAN.md`](../UI_STREAMLINE_IMPLEMENTATION_PLAN.md).

## Responsive review matrix

Review at 320×568, 360×800, 390×844, 430×932, 768×1024, 1024×768, 1280×720,
1440×900, 1920×1080, and 2560×1440. Confirm no horizontal overflow, 44px touch
targets, one title, activity-strip geometry, KPI popover bounds, focus-managed
sheets/dialogs, and no workspace/activity/nav overlap. Browser computed-geometry
and visual baseline checks remain closure work; static helpers do not prove them.

## Recorded verification

The last source verification recorded passing HUD tests, lint, build, and
`git diff --check`. Browser visual/computed geometry and accessibility baselines
are intentionally not claimed here until run against the matrix.
